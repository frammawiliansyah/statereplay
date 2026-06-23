import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StateReplay, createStateReplay } from "../../src/core/StateReplay.js";
import { StateReplayValidationError } from "../../src/core/errors.js";
import { createTempStorage, removeTempStorage } from "../helpers/tempDir.js";

const childPath = fileURLToPath(new URL("./crashChild.ts", import.meta.url));

/** Spawn the crash child (which SIGKILLs itself) and resolve once it has exited. */
function runCrashChild(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath, dir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await createTempStorage();
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => removeTempStorage(d)));
});

describe("integration: crash simulation", () => {
  it("recovers an fsync'd write after a hard crash (SIGKILL, no clean close)", async () => {
    const dir = await tmp();
    await runCrashChild(dir);

    const sr = await createStateReplay<{ amount: number }>({
      storagePath: dir,
      durability: "fsync",
      lock: false,
    });
    const state = sr.getState("transfer-001");
    expect(state?.step).toBe("CEX_WITHDRAWAL");
    expect(state?.status).toBe("PROCESSING");
    expect(state?.data?.amount).toBe(100);
    await sr.close();
  }, 30_000);

  it("skips a truncated trailing line (crash mid-append) with a non-fatal replayWarning", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    await a.setState("job-1", { step: "INIT", status: "PROCESSING" });
    await a.close();
    // A partial line with NO terminating newline — exactly what a crash mid-append leaves.
    await appendFile(join(dir, "events.jsonl"), '{"v":1,"id":"job-2","ts":1,"payl');

    const sr = new StateReplay({ storagePath: dir, lock: false });
    const warnings: Array<{ fatal: boolean }> = [];
    sr.on("replayWarning", (w) => warnings.push(w));
    await sr.init();
    expect(sr.getState("job-1")?.status).toBe("PROCESSING");
    expect(sr.getState("job-2")).toBeUndefined();
    expect(warnings.some((w) => w.fatal === false)).toBe(true);
    await sr.close();
  });

  it("throws on interior corruption when tolerantReplay:false (fail closed)", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    await a.setState("job-1", { step: "INIT", status: "PROCESSING" });
    await a.close();
    // A corrupt INTERIOR line (followed by a valid line, so it is not the truncated tail).
    const log = join(dir, "events.jsonl");
    await appendFile(log, "this is not valid json\n");
    await appendFile(
      log,
      '{"v":1,"id":"job-3","ts":2,"payload":{"step":"Y","status":"PENDING"}}\n',
    );

    const strict = new StateReplay({ storagePath: dir, lock: false, tolerantReplay: false });
    await expect(strict.init()).rejects.toBeInstanceOf(StateReplayValidationError);
  });

  it("skips interior corruption (tolerant) and still applies later valid lines", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    await a.setState("job-1", { step: "INIT", status: "PROCESSING" });
    await a.close();
    const log = join(dir, "events.jsonl");
    await appendFile(log, "garbage interior line\n");
    await appendFile(
      log,
      '{"v":1,"id":"job-3","ts":2,"payload":{"step":"Y","status":"PENDING"}}\n',
    );

    const sr = new StateReplay({ storagePath: dir, lock: false });
    const warnings: Array<{ fatal: boolean }> = [];
    sr.on("replayWarning", (w) => warnings.push(w));
    await sr.init();
    expect(sr.getState("job-1")?.status).toBe("PROCESSING");
    expect(sr.getState("job-3")?.step).toBe("Y");
    expect(warnings.some((w) => w.fatal === false)).toBe(true);
    await sr.close();
  });
});
