import { randomBytes } from "node:crypto";
import { createReadStream, unlinkSync } from "node:fs";
import {
  type FileHandle,
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StateReplayLockError, StateReplayValidationError } from "./errors.js";

export type Durability = "fsync" | "flush" | "none";

export interface FileManagerOptions {
  storagePath: string;
  /** Default: "events.jsonl". */
  logFileName?: string;
  /** Default: "fsync". */
  durability?: Durability;
  /** Default: true. */
  lock?: boolean;
  /** Default: 10_000 — a same-host lock whose PID is dead is stealable; an unreadable one only once this old. */
  lockStaleMs?: number;
  /** Default: 0o600 (Unix only; no-op on Windows). */
  fileMode?: number;
  /** Default: 0o700 (Unix only; no-op on Windows). */
  dirMode?: number;
}

/** Contents of meta.json — non-secret storage metadata that lives next to the log. */
export interface StorageMeta {
  /** Format provenance marker. */
  format: "statereplay";
  schemaVersion: number;
  createdAt: number;
  /** base64 random salt for scrypt key derivation, generated once per deployment. */
  kdfSalt: string;
}

interface PendingWrite {
  buf: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface LineRecord {
  lineNumber: number;
  raw: string;
}

/** Return the errno `code` of a thrown filesystem error, or undefined. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Filesystem I/O, durability, and the advisory lock.
 * Holds every `fs` call and zero business logic — parsing, encryption, and
 * corrupt-line classification all live in StateReplay.
 */
export class FileManager {
  private readonly storagePath: string;
  private readonly logFileName: string;
  private readonly logPath: string;
  private readonly metaPath: string;
  private readonly lockPath: string;
  private readonly durability: Durability;
  private readonly lockEnabled: boolean;
  private readonly lockStaleMs: number;
  private readonly fileMode: number;
  private readonly dirMode: number;

  private handle: FileHandle | null = null;
  private pending: PendingWrite[] = [];
  private flushScheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private lockHeld = false;
  private exitHandler?: () => void;

  constructor(options: FileManagerOptions) {
    this.storagePath = resolve(options.storagePath);
    this.logFileName = options.logFileName ?? "events.jsonl";
    this.logPath = join(this.storagePath, this.logFileName);
    this.metaPath = join(this.storagePath, "meta.json");
    this.lockPath = join(this.storagePath, `${this.logFileName}.lock`);
    this.durability = options.durability ?? "fsync";
    this.lockEnabled = options.lock ?? true;
    this.lockStaleMs = options.lockStaleMs ?? 10_000;
    this.fileMode = options.fileMode ?? 0o600;
    this.dirMode = options.dirMode ?? 0o700;
  }

  /** Absolute path to the log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /** Create the storage dir (chmod on Unix), fsync the parent dir, and ensure meta.json exists. */
  async ensureStorage(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true, mode: this.dirMode });
    await this.chmodSafe(this.storagePath, this.dirMode);
    await this.ensureMeta();
    await this.fsyncDir();
  }

  /** Read meta.json (e.g. for the scrypt salt). */
  async getMeta(): Promise<StorageMeta> {
    const raw = await readFile(this.metaPath, "utf8");
    return JSON.parse(raw) as StorageMeta;
  }

  /** Acquire the advisory single-writer lock. No-op when `lock: false`. */
  async acquireLock(): Promise<void> {
    if (!this.lockEnabled) {
      return;
    }
    await this.tryAcquireLock(true);
    this.lockHeld = true;
    this.registerExitCleanup();
  }

  /** Append one line + "\n", resolving per the configured durability level. */
  appendLine(line: string): Promise<void> {
    if (line.includes("\n")) {
      return Promise.reject(
        new StateReplayValidationError(
          "Refusing to append a log line containing a newline character",
        ),
      );
    }
    return new Promise<void>((res, rej) => {
      this.pending.push({ buf: Buffer.from(`${line}\n`, "utf8"), resolve: res, reject: rej });
      this.scheduleFlush();
    });
  }

  /**
   * Stream the log via readline. Yields each raw line with a one-line lookahead so the
   * final line can be flagged. `truncated` is true only for a final line with no terminating
   * newline (a crash mid-append) — that is what lets the caller treat *only* a genuinely
   * truncated tail as a benign trailing partial, while a complete-but-corrupt final line is
   * still real corruption (§7). FileManager stays free of parsing/decryption.
   */
  async *replayLines(): AsyncGenerator<{
    lineNumber: number;
    raw: string;
    isLast: boolean;
    truncated: boolean;
  }> {
    if (!(await this.exists(this.logPath))) {
      return;
    }
    const endsWithNewline = await this.endsWithNewline();
    const stream = createReadStream(this.logPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let lineNumber = 0;
    let prev: LineRecord | null = null;
    try {
      for await (const raw of rl) {
        if (prev !== null) {
          yield { lineNumber: prev.lineNumber, raw: prev.raw, isLast: false, truncated: false };
        }
        lineNumber += 1;
        prev = { lineNumber, raw };
      }
      if (prev !== null) {
        yield {
          lineNumber: prev.lineNumber,
          raw: prev.raw,
          isLast: true,
          truncated: !endsWithNewline,
        };
      }
    } finally {
      rl.close();
      stream.close();
    }
  }

  /** True if the log's final byte is "\n" (the last line is complete, not a truncated tail). */
  private async endsWithNewline(): Promise<boolean> {
    const size = await this.byteSize();
    if (size === 0) {
      return true;
    }
    const fh = await open(this.logPath, "r");
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      await fh.close();
    }
  }

  /** Current log size in bytes (0 if the log does not exist yet). */
  async byteSize(): Promise<number> {
    try {
      return (await stat(this.logPath)).size;
    } catch {
      return 0;
    }
  }

  /** Drain pending writes, fsync + close the handle, and release the lock. */
  async close(): Promise<void> {
    await this.drain();
    if (this.handle !== null) {
      try {
        await this.handle.datasync();
      } catch {
        // best-effort final sync
      }
      await this.handle.close();
      this.handle = null;
    }
    await this.releaseLock();
  }

  // --- write path (group commit) ---------------------------------------------

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushing = this.flushing.then(() => this.flushBatch());
    });
  }

  private async drain(): Promise<void> {
    // Settle the current chain, then flush any stragglers queued but not yet scheduled.
    await this.flushing;
    if (this.pending.length > 0) {
      await this.flushBatch();
    }
  }

  /** Coalesce all currently-pending appends into a single write (+ datasync for "fsync"). */
  private async flushBatch(): Promise<void> {
    const batch = this.pending;
    if (batch.length === 0) {
      return;
    }
    this.pending = [];
    const buf = Buffer.concat(batch.map((p) => p.buf));
    const resolveAll = (): void => {
      for (const p of batch) {
        p.resolve();
      }
    };
    try {
      const fh = await this.getHandle();
      if (this.durability === "none") {
        // Weakest level: resolve as soon as the write is issued. We still await it
        // to keep the serial on-disk order intact for the next batch.
        const writeP = fh.write(buf);
        resolveAll();
        await writeP;
        return;
      }
      await fh.write(buf);
      if (this.durability === "fsync") {
        await fh.datasync();
      }
      resolveAll();
    } catch (err) {
      for (const p of batch) {
        p.reject(err);
      }
    }
  }

  private async getHandle(): Promise<FileHandle> {
    if (this.handle === null) {
      this.handle = await open(this.logPath, "a", this.fileMode);
      // Make the (possibly newly created) log file's directory entry durable, once.
      await this.fsyncDir();
      await this.chmodSafe(this.logPath, this.fileMode);
    }
    return this.handle;
  }

  // --- storage helpers -------------------------------------------------------

  private async ensureMeta(): Promise<void> {
    if (await this.exists(this.metaPath)) {
      return;
    }
    const meta: StorageMeta = {
      format: "statereplay",
      schemaVersion: 1,
      createdAt: Date.now(),
      kdfSalt: randomBytes(16).toString("base64"),
    };
    try {
      await writeFile(this.metaPath, `${JSON.stringify(meta)}\n`, {
        mode: this.fileMode,
        flag: "wx",
      });
    } catch (err) {
      // A concurrent process may have created it first; that is fine.
      if (errnoCode(err) !== "EEXIST") {
        throw err;
      }
    }
    await this.chmodSafe(this.metaPath, this.fileMode);
  }

  private async fsyncDir(): Promise<void> {
    let dh: FileHandle | undefined;
    try {
      dh = await open(this.storagePath, "r");
      await dh.sync();
    } catch {
      // Some platforms (notably Windows) reject fsync on a directory handle.
      // Directory-entry durability is best-effort hardening; ignore where unsupported.
    } finally {
      await dh?.close();
    }
  }

  private async chmodSafe(target: string, mode: number): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    try {
      await chmod(target, mode);
    } catch {
      // Permissions are hardening, not correctness; tolerate exotic filesystems.
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  // --- advisory lock ---------------------------------------------------------

  private async tryAcquireLock(allowSteal: boolean): Promise<void> {
    const record = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now(),
    });
    try {
      const fh = await open(this.lockPath, "wx", this.fileMode);
      await fh.writeFile(record);
      await fh.close();
      return;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") {
        throw err;
      }
    }
    if (allowSteal && (await this.lockIsStale())) {
      await rm(this.lockPath, { force: true });
      // Steal exactly once: a second EEXIST now means a live race → fail loud.
      await this.tryAcquireLock(false);
      return;
    }
    throw new StateReplayLockError(
      `StateReplay log is locked by another live process: ${this.lockPath}`,
    );
  }

  private async lockIsStale(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch {
      return this.lockOlderThanStale();
    }
    let holder: { pid?: unknown; hostname?: unknown };
    try {
      holder = JSON.parse(raw) as { pid?: unknown; hostname?: unknown };
    } catch {
      // Unreadable/incomplete record (crash mid-creation) — stale only once old enough.
      return this.lockOlderThanStale();
    }
    const pid = typeof holder.pid === "number" ? holder.pid : undefined;
    const host = typeof holder.hostname === "string" ? holder.hostname : undefined;
    if (pid === undefined || host === undefined) {
      return this.lockOlderThanStale();
    }
    if (host !== hostname()) {
      // Different host — we cannot probe liveness, and never steal across hosts on age alone.
      return false;
    }
    return !pidAlive(pid);
  }

  private async lockOlderThanStale(): Promise<boolean> {
    try {
      const st = await stat(this.lockPath);
      return Date.now() - st.mtimeMs > this.lockStaleMs;
    } catch {
      return true;
    }
  }

  private registerExitCleanup(): void {
    if (this.exitHandler !== undefined) {
      return;
    }
    this.exitHandler = () => {
      if (this.lockHeld) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          // best-effort
        }
      }
    };
    process.on("exit", this.exitHandler);
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) {
      return;
    }
    this.lockHeld = false;
    if (this.exitHandler !== undefined) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
    try {
      await rm(this.lockPath, { force: true });
    } catch {
      // best-effort
    }
  }
}

/** Liveness probe: signal 0 throws ESRCH for a dead PID, EPERM for a live one we don't own. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}
