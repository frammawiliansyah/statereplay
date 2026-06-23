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
});
