import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateReplay, createStateReplay } from "../../src/core/StateReplay.js";
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

describe("integration: restart replay", () => {
  it("instance A writes a multi-step workflow, closes; instance B resumes to the same state", async () => {
    const dir = await tmp();
    // Default options: fsync durability + advisory lock — the real production path.
    const a = await createStateReplay({ storagePath: dir });
    await a.setState("transfer-001", { step: "INIT", status: "PENDING" });
    await a.setState("transfer-001", { step: "CEX_WITHDRAWAL", status: "PROCESSING" });
    await a.setState("transfer-001", {
      step: "CEX_WITHDRAWAL",
      status: "SUCCESS",
      data: { txHash: "0xabc" },
    });
    await a.setState("transfer-002", { step: "INIT", status: "PENDING" });
    await a.close();

    const b = await createStateReplay({ storagePath: dir });
    expect(b.getState("transfer-001")?.status).toBe("SUCCESS"); // last-write-wins
    expect(b.getState("transfer-001")?.data?.txHash).toBe("0xabc");
    expect(b.getState("transfer-002")?.status).toBe("PENDING");
    expect(b.listIds().sort()).toEqual(["transfer-001", "transfer-002"]);
    expect(b.getStats().eventCount).toBe(4);
    expect(b.getStats().idCount).toBe(2);
    await b.close();
  });

  it("treats an unknown future schema version as a corrupt line (tolerant skip)", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    await a.setState("job-1", { step: "INIT", status: "PENDING" });
    await a.close();
    // An interior unknown-version (v2) line, followed by a later valid v1 line.
    const log = join(dir, "events.jsonl");
    await appendFile(
      log,
      '{"v":2,"id":"future","ts":1,"payload":{"step":"X","status":"PENDING"}}\n',
    );
    await appendFile(
      log,
      '{"v":1,"id":"job-2","ts":2,"payload":{"step":"Y","status":"PENDING"}}\n',
    );

    const sr = new StateReplay({ storagePath: dir, lock: false });
    const warnings: Array<{ fatal: boolean }> = [];
    sr.on("replayWarning", (w) => warnings.push(w));
    await sr.init();
    expect(sr.getState("job-1")?.step).toBe("INIT");
    expect(sr.getState("job-2")?.step).toBe("Y");
    expect(sr.getState("future")).toBeUndefined();
    expect(warnings.some((w) => w.fatal === false)).toBe(true);
    await sr.close();
  });
});
