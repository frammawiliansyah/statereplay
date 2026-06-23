import { open, readFile, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManager } from "../../src/core/FileManager.js";
import { StateReplayLockError, StateReplayValidationError } from "../../src/core/errors.js";
import { createTempStorage, removeTempStorage } from "../helpers/tempDir.js";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await createTempStorage();
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => removeTempStorage(d)));
});

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Find a PID that is reliably dead on this host. */
function deadPid(): number {
  for (let pid = 4_194_303; pid > 1; pid -= 4_999) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (errCode(err) === "ESRCH") {
        return pid;
      }
    }
  }
  return 2_147_483_646;
}

describe("FileManager", () => {
  it("ensureStorage creates the directory and meta.json with a 16-byte kdfSalt", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    expect(meta.schemaVersion).toBe(1);
    expect(typeof meta.kdfSalt).toBe("string");
    expect(Buffer.from(meta.kdfSalt, "base64")).toHaveLength(16);
  });

  it("appendLine('a') then appendLine('b') yields exactly 'a\\nb\\n'", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    await fm.appendLine("a");
    await fm.appendLine("b");
    await fm.close();
    expect(await readFile(fm.getLogPath(), "utf8")).toBe("a\nb\n");
  });

  it("produces identical content under every durability level", async () => {
    for (const durability of ["fsync", "flush", "none"] as const) {
      const dir = await tmp();
      const fm = new FileManager({ storagePath: dir, lock: false, durability });
      await fm.ensureStorage();
      await fm.appendLine("a");
      await fm.appendLine("b");
      await fm.close();
      expect(await readFile(fm.getLogPath(), "utf8")).toBe("a\nb\n");
    }
  });

  it("rejects an appendLine containing an embedded newline", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    await expect(fm.appendLine("x\ny")).rejects.toBeInstanceOf(StateReplayValidationError);
    await fm.close();
  });

  it("serializes 100 concurrent appends in call order with a single trailing newline", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    await Promise.all(Array.from({ length: 100 }, (_, i) => fm.appendLine(`line-${i}`)));
    await fm.close();
    const content = await readFile(fm.getLogPath(), "utf8");
    const lines = content.split("\n");
    expect(lines).toHaveLength(101); // 100 lines + a trailing "" after the final \n
    expect(lines[100]).toBe("");
    expect(lines.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => `line-${i}`));
  });

  it("calls datasync on the handle for durability 'fsync' but not for 'none'", async () => {
    const probeDir = await tmp();
    const probe = await open(join(probeDir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const datasyncSpy = vi.spyOn(proto, "datasync");
    try {
      const d1 = await tmp();
      const fm1 = new FileManager({ storagePath: d1, lock: false, durability: "fsync" });
      await fm1.ensureStorage();
      datasyncSpy.mockClear();
      await fm1.appendLine("a");
      expect(datasyncSpy).toHaveBeenCalled();
      await fm1.close();

      const d2 = await tmp();
      const fm2 = new FileManager({ storagePath: d2, lock: false, durability: "none" });
      await fm2.ensureStorage();
      datasyncSpy.mockClear();
      await fm2.appendLine("a");
      expect(datasyncSpy).not.toHaveBeenCalled(); // assert before close (close does a final datasync)
      await fm2.close();
    } finally {
      datasyncSpy.mockRestore();
    }
  });

  it("replayLines yields lines in order, marking only the last", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    await fm.appendLine("one");
    await fm.appendLine("two");
    await fm.appendLine("three");
    await fm.close();
    const got: Array<{ lineNumber: number; raw: string; isLast: boolean; truncated: boolean }> = [];
    for await (const line of fm.replayLines()) {
      got.push(line);
    }
    expect(got.map((l) => l.raw)).toEqual(["one", "two", "three"]);
    expect(got.map((l) => l.isLast)).toEqual([false, false, true]);
    expect(got.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    // A cleanly closed log ends with "\n" → no truncated tail.
    expect(got.map((l) => l.truncated)).toEqual([false, false, false]);
  });

  it("flags a truncated trailing line (no final newline) as isLast", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    await writeFile(fm.getLogPath(), 'good\n{"v":1,"id":"x"');
    const got: Array<{ raw: string; isLast: boolean; truncated: boolean }> = [];
    for await (const line of fm.replayLines()) {
      got.push({ raw: line.raw, isLast: line.isLast, truncated: line.truncated });
    }
    expect(got).toEqual([
      { raw: "good", isLast: false, truncated: false },
      { raw: '{"v":1,"id":"x"', isLast: true, truncated: true },
    ]);
  });

  it("replayLines on a missing log yields nothing", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    const got: unknown[] = [];
    for await (const line of fm.replayLines()) {
      got.push(line);
    }
    expect(got).toHaveLength(0);
  });

  it("byteSize reflects the written bytes", async () => {
    const dir = await tmp();
    const fm = new FileManager({ storagePath: dir, lock: false });
    await fm.ensureStorage();
    expect(await fm.byteSize()).toBe(0);
    await fm.appendLine("hello");
    await fm.close();
    expect(await fm.byteSize()).toBe(6); // "hello\n"
  });

  describe("advisory lock", () => {
    it("throws StateReplayLockError when a second live process holds the lock", async () => {
      const dir = await tmp();
      const a = new FileManager({ storagePath: dir });
      await a.ensureStorage();
      await a.acquireLock();
      const b = new FileManager({ storagePath: dir });
      await b.ensureStorage();
      await expect(b.acquireLock()).rejects.toBeInstanceOf(StateReplayLockError);
      await a.close();
    });

    it("steals a same-host lock whose PID is dead", async () => {
      const dir = await tmp();
      const lockPath = join(dir, "events.jsonl.lock");
      await writeFile(
        lockPath,
        JSON.stringify({ pid: deadPid(), hostname: hostname(), startedAt: Date.now() }),
      );
      const fm = new FileManager({ storagePath: dir });
      await fm.ensureStorage();
      await expect(fm.acquireLock()).resolves.toBeUndefined();
      await fm.close();
    });

    it("does NOT steal a fresh unreadable lock", async () => {
      const dir = await tmp();
      await writeFile(join(dir, "events.jsonl.lock"), "{ broken json");
      const fm = new FileManager({ storagePath: dir, lockStaleMs: 10_000 });
      await fm.ensureStorage();
      await expect(fm.acquireLock()).rejects.toBeInstanceOf(StateReplayLockError);
    });

    it("steals an unreadable lock older than lockStaleMs", async () => {
      const dir = await tmp();
      const lockPath = join(dir, "events.jsonl.lock");
      await writeFile(lockPath, "{ broken");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
      const fm = new FileManager({ storagePath: dir, lockStaleMs: 10_000 });
      await fm.ensureStorage();
      await expect(fm.acquireLock()).resolves.toBeUndefined();
      await fm.close();
    });

    it("releases the lock on close so it can be re-acquired", async () => {
      const dir = await tmp();
      const a = new FileManager({ storagePath: dir });
      await a.ensureStorage();
      await a.acquireLock();
      await a.close();
      const b = new FileManager({ storagePath: dir });
      await b.ensureStorage();
      await expect(b.acquireLock()).resolves.toBeUndefined();
      await b.close();
    });

    it("is a no-op when lock:false (no lockfile created)", async () => {
      const dir = await tmp();
      const fm = new FileManager({ storagePath: dir, lock: false });
      await fm.ensureStorage();
      await fm.acquireLock();
      await expect(readFile(join(dir, "events.jsonl.lock"), "utf8")).rejects.toBeDefined();
      await fm.close();
    });
  });
});
