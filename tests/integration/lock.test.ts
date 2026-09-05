import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateReplay } from "../../src/core/StateReplay.js";
import { StateReplayLockError } from "../../src/core/errors.js";
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

describe("integration: advisory lock", () => {
  it("a second instance on a live-locked path throws StateReplayLockError", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir }); // default lock: true
    await expect(createStateReplay({ storagePath: dir })).rejects.toBeInstanceOf(
      StateReplayLockError,
    );
    await a.close();
  });

  it("releases the lock on close so a new instance can open and replay", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir });
    await a.setState("job-1", { step: "INIT", status: "PENDING" });
    await a.close();

    const b = await createStateReplay({ storagePath: dir });
    expect(b.getState("job-1")?.status).toBe("PENDING");
    await b.close();
  });

  it("lock:false allows concurrent instances on the same path", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    const b = await createStateReplay({ storagePath: dir, lock: false });
    await a.close();
    await b.close();
  });

  it("releases the lock when init fails, so a retry can succeed", async () => {
    const dir = await tmp();
    const seed = await createStateReplay({ storagePath: dir, lock: false });
    await seed.setState("job-1", { step: "INIT", status: "PENDING" });
    await seed.close();
    await writeFile(join(dir, "events.jsonl"), "{not json at all}\n");

    // Strict replay fails — but must not strand the lockfile.
    await expect(
      createStateReplay({ storagePath: dir, tolerantReplay: false }),
    ).rejects.toThrowError();

    // A tolerant instance can still acquire the same path.
    const ok = await createStateReplay({ storagePath: dir });
    expect(ok.ready).toBe(true);
    await ok.close();
  });

  it("does not remove a lockfile that another holder recreated", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir });
    const lockPath = join(dir, "events.jsonl.lock");
    const ours = await readFile(lockPath, "utf8");
    expect(JSON.parse(ours).nonce).toBeTypeOf("string");

    // Simulate another process replacing the lock while we hold it.
    const theirs = JSON.stringify({
      pid: process.pid,
      hostname: "other-host",
      startedAt: Date.now(),
      nonce: "someone-elses-nonce",
    });
    await writeFile(lockPath, theirs);

    await a.close();
    // close() must leave the other holder's lock intact.
    expect(await readFile(lockPath, "utf8")).toBe(theirs);
  });
});
