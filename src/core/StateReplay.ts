import { EventEmitter } from "node:events";
import type {
  StateChangeEvent,
  StatePayload,
  StateReplayEventMap,
  StateReplayOptions,
  StateReplayStats,
  StateStatus,
} from "../types/index.js";
import { CryptoUtil, type EncryptedBlob } from "./CryptoUtil.js";
import { FileManager } from "./FileManager.js";
import {
  StateReplayClosedError,
  StateReplayConfigError,
  StateReplayDecryptError,
  StateReplayError,
  StateReplayValidationError,
} from "./errors.js";

const CURRENT_SCHEMA_VERSION = 1 as const;
const MAX_ID_LENGTH = 256;
const VALID_STATUSES: ReadonlySet<StateStatus> = new Set<StateStatus>([
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "COMPLETED",
]);

interface LogEntryPlain<TData> {
  v: typeof CURRENT_SCHEMA_VERSION;
  id: string;
  ts: number;
  payload: StatePayload<TData>;
}

interface LogEntryEncrypted {
  v: typeof CURRENT_SCHEMA_VERSION;
  id: string;
  ts: number;
  enc: true;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

type LogEntry<TData> = LogEntryPlain<TData> | LogEntryEncrypted;

/** Frozen deep clone — the read/event boundary that keeps the live cache unreachable to callers. */
function cloneFrozen<T>(value: T): Readonly<T> {
  return Object.freeze(structuredClone(value));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Typed EventEmitter: Node's EventEmitter is not generic, so we declaration-merge typed
// on/once/off/emit overloads over the class.
type Listener<A extends unknown[]> = (...args: A) => void;
export interface StateReplay<TData = Record<string, unknown>> {
  on<E extends keyof StateReplayEventMap<TData>>(
    e: E,
    l: Listener<StateReplayEventMap<TData>[E]>,
  ): this;
  once<E extends keyof StateReplayEventMap<TData>>(
    e: E,
    l: Listener<StateReplayEventMap<TData>[E]>,
  ): this;
  off<E extends keyof StateReplayEventMap<TData>>(
    e: E,
    l: Listener<StateReplayEventMap<TData>[E]>,
  ): this;
  emit<E extends keyof StateReplayEventMap<TData>>(
    e: E,
    ...args: StateReplayEventMap<TData>[E]
  ): boolean;
}

/**
 * Orchestrator: in-memory cache, public API, typed events, stats, lifecycle.
 * Holds zero raw `fs` calls — all I/O is delegated to {@link FileManager}.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: interface adds only typed on/once/off/emit overloads — the spec's typed-EventEmitter pattern (§9.1).
export class StateReplay<TData = Record<string, unknown>> extends EventEmitter {
  private readonly options: StateReplayOptions;
  private readonly fileManager: FileManager;
  private readonly tolerantReplay: boolean;
  private readonly encryptEnabled: boolean;
  private encryptionKey?: Buffer;

  private readonly cache = new Map<string, StatePayload<TData>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly stats: StateReplayStats = {
    eventCount: 0,
    idCount: 0,
    logSizeBytes: 0,
    lastReplayDurationMs: 0,
    lastWriteAt: null,
  };
  private closed = false;
  private _ready = false;
  private initPromise?: Promise<void>;

  constructor(options: StateReplayOptions) {
    super();
    this.options = options;
    this.tolerantReplay = options.tolerantReplay ?? true;
    this.encryptEnabled = options.encrypt ?? false;
    this.fileManager = new FileManager({
      storagePath: options.storagePath,
      logFileName: options.logFileName,
      durability: options.durability,
      lock: options.lock,
      lockStaleMs: options.lockStaleMs,
    });
    if (options.autoInit === true) {
      // Advanced path: a failed init surfaces on the 'error' channel (see the factory docs, §9.4).
      this.init().catch((err) => this.emit("error", toError(err)));
    }
  }

  /** True once replay has completed. */
  get ready(): boolean {
    return this._ready;
  }

  /** Idempotent: ensureStorage → acquireLock → replay → emit('ready'). */
  async init(): Promise<void> {
    if (this._ready) {
      return;
    }
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.encryptEnabled && this.options.secretKey === undefined) {
      throw new StateReplayConfigError("encrypt: true requires a secretKey");
    }
    await this.fileManager.ensureStorage();
    await this.fileManager.acquireLock();
    if (this.encryptEnabled && this.options.secretKey !== undefined) {
      const meta = await this.fileManager.getMeta();
      this.encryptionKey = CryptoUtil.resolveKey(
        this.options.secretKey,
        Buffer.from(meta.kdfSalt, "base64"),
      );
    }
    const start = Date.now();
    await this.replay();
    this.stats.lastReplayDurationMs = Date.now() - start;
    this.stats.idCount = this.cache.size;
    this.stats.logSizeBytes = await this.fileManager.byteSize();
    this._ready = true;
    this.emit("ready");
  }

  async setState(id: string, payload: StatePayload<TData>): Promise<void> {
    if (this.closed) {
      throw new StateReplayClosedError("setState called after close()");
    }
    if (!this._ready) {
      await this.init();
    }
    this.validateId(id);
    this.validatePayload(payload);
    const stored: StatePayload<TData> = { ...payload, timestamp: payload.timestamp ?? Date.now() };
    const line = JSON.stringify(this.buildEntry(id, stored));
    // Issue the append NOW (synchronously) so concurrent setState calls reach FileManager in the
    // same tick and share a single group-committed fsync — that is what makes `fsync` viable as the
    // default. The cache/stat/event apply is still serialized in call order via writeQueue, and
    // never runs before this line's durability level is met.
    const durable = this.fileManager.appendLine(line);
    const op = this.writeQueue.then(async () => {
      await durable;
      this.applyWrite(id, stored, line);
    });
    this.writeQueue = op.catch(() => {});
    return op;
  }

  getState(id: string): Readonly<StatePayload<TData>> | undefined {
    const cached = this.cache.get(id);
    return cached === undefined ? undefined : cloneFrozen(cached);
  }

  getAllStates(): ReadonlyMap<string, Readonly<StatePayload<TData>>> {
    const out = new Map<string, Readonly<StatePayload<TData>>>();
    for (const [id, payload] of this.cache) {
      out.set(id, cloneFrozen(payload));
    }
    return out;
  }

  listIds(): string[] {
    return [...this.cache.keys()];
  }

  getStats(): StateReplayStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.writeQueue.catch(() => {});
    await this.fileManager.close();
  }

  // --- internals -------------------------------------------------------------

  /** Apply an already-durable write to the cache, stats, and `change` event — serialized in call order. */
  private applyWrite(id: string, payload: StatePayload<TData>, line: string): void {
    const cachedPrev = this.cache.get(id);
    const previous = cachedPrev === undefined ? null : cloneFrozen(cachedPrev);
    const current = cloneFrozen(payload);
    this.cache.set(id, current);
    this.stats.eventCount += 1;
    this.stats.lastWriteAt = payload.timestamp ?? Date.now();
    this.stats.idCount = this.cache.size;
    this.stats.logSizeBytes += Buffer.byteLength(line, "utf8") + 1;
    const event: StateChangeEvent<TData> = { id, previous, current };
    this.emit("change", event);
  }

  private buildEntry(id: string, payload: StatePayload<TData>): LogEntry<TData> {
    const ts = payload.timestamp ?? Date.now();
    if (this.encryptEnabled && this.encryptionKey !== undefined) {
      const blob = CryptoUtil.encrypt(JSON.stringify(payload), this.encryptionKey);
      return {
        v: CURRENT_SCHEMA_VERSION,
        id,
        ts,
        enc: true,
        alg: "aes-256-gcm",
        iv: blob.iv,
        tag: blob.tag,
        data: blob.data,
      };
    }
    return { v: CURRENT_SCHEMA_VERSION, id, ts, payload };
  }

  private async replay(): Promise<void> {
    for await (const { lineNumber, raw, truncated } of this.fileManager.replayLines()) {
      try {
        const { id, payload } = this.decodeLine(raw);
        this.cache.set(id, cloneFrozen(payload));
        this.stats.eventCount += 1;
      } catch (err) {
        this.handleCorruptLine(lineNumber, truncated, err);
      }
    }
  }

  private decodeLine(raw: string): { id: string; payload: StatePayload<TData> } {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.v !== CURRENT_SCHEMA_VERSION) {
      // Unknown/newer schema version (file written by a newer StateReplay) → corrupt-line rule (§7).
      throw new StateReplayValidationError(`Unsupported log schema version: ${String(parsed.v)}`);
    }
    if (typeof parsed.id !== "string") {
      throw new StateReplayValidationError("Log entry is missing a string id");
    }
    if (parsed.enc === true) {
      if (this.encryptionKey === undefined) {
        throw new StateReplayDecryptError(
          "Encountered an encrypted line but no secretKey is configured",
        );
      }
      const blob: EncryptedBlob = {
        iv: String(parsed.iv),
        tag: String(parsed.tag),
        data: String(parsed.data),
      };
      const plaintext = CryptoUtil.decrypt(blob, this.encryptionKey);
      return { id: parsed.id, payload: JSON.parse(plaintext) as StatePayload<TData> };
    }
    if (typeof parsed.payload !== "object" || parsed.payload === null) {
      throw new StateReplayValidationError("Log entry is missing a payload object");
    }
    return { id: parsed.id, payload: parsed.payload as StatePayload<TData> };
  }

  private handleCorruptLine(lineNumber: number, truncated: boolean, err: unknown): void {
    if (truncated) {
      // Truncated tail (crash mid-append): benign — never fatal, even in strict mode (§7).
      this.emit("replayWarning", {
        lineNumber,
        message: `Skipped trailing partial line: ${errMessage(err)}`,
        fatal: false,
      });
      return;
    }
    if (this.tolerantReplay) {
      this.emit("replayWarning", {
        lineNumber,
        message: `Skipped corrupt line: ${errMessage(err)}`,
        fatal: false,
      });
      return;
    }
    // Strict mode: fail closed.
    if (err instanceof StateReplayError) {
      throw err;
    }
    throw new StateReplayValidationError(`Corrupt log line ${lineNumber}: ${errMessage(err)}`, {
      cause: err,
    });
  }

  private validateId(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new StateReplayValidationError("id must be a non-empty string");
    }
    if (id.length > MAX_ID_LENGTH) {
      throw new StateReplayValidationError(`id exceeds the ${MAX_ID_LENGTH}-character limit`);
    }
  }

  private validatePayload(payload: StatePayload<TData>): void {
    if (typeof payload !== "object" || payload === null) {
      throw new StateReplayValidationError("payload must be an object");
    }
    if (typeof payload.step !== "string" || payload.step.length === 0) {
      throw new StateReplayValidationError("payload.step must be a non-empty string");
    }
    if (!VALID_STATUSES.has(payload.status)) {
      throw new StateReplayValidationError(
        `payload.status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    try {
      JSON.stringify(payload);
    } catch (err) {
      throw new StateReplayValidationError("payload.data must be JSON-serializable", {
        cause: err,
      });
    }
  }
}

/**
 * Recommended entry point: constructs and awaits `init()`.
 * A failed init rejects the returned promise — no floating-promise footgun.
 */
export async function createStateReplay<TData = Record<string, unknown>>(
  options: StateReplayOptions,
): Promise<StateReplay<TData>> {
  const sr = new StateReplay<TData>({ ...options, autoInit: false });
  await sr.init();
  return sr;
}
