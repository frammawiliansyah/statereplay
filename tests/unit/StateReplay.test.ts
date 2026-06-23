import { afterEach, describe, expect, it } from "vitest";
import { createStateReplay } from "../../src/core/StateReplay.js";
import {
  StateReplayClosedError,
  StateReplayConfigError,
  StateReplayValidationError,
} from "../../src/core/errors.js";
import type { StateChangeEvent } from "../../src/types/index.js";
import { createTempStorage, removeTempStorage } from "../helpers/tempDir.js";

interface JobData {
  txHash?: string;
  amount?: number;
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

function openReplay(dir: string) {
  return createStateReplay<JobData>({ storagePath: dir, lock: false });
}

describe("StateReplay", () => {
  it("setState then getState returns the payload with an auto-filled timestamp", async () => {
    const sr = await openReplay(await tmp());
    await sr.setState("job-1", { step: "INIT", status: "PENDING" });
    const state = sr.getState("job-1");
    expect(state?.step).toBe("INIT");
    expect(state?.status).toBe("PENDING");
    expect(typeof state?.timestamp).toBe("number");
    await sr.close();
  });

  it("returns a frozen clone; mutating it does not change a subsequent getState", async () => {
    const sr = await openReplay(await tmp());
    await sr.setState("job-1", { step: "INIT", status: "PROCESSING", data: { amount: 5 } });
    const a = sr.getState("job-1");
    expect(a).toBeDefined();
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { status: string }).status = "SUCCESS";
    }).toThrow();
    // A subsequent read is unaffected, and returns a distinct object identity.
    expect(sr.getState("job-1")?.status).toBe("PROCESSING");
    expect(sr.getState("job-1")).not.toBe(sr.getState("job-1"));
    await sr.close();
  });

  it("throws StateReplayValidationError on invalid inputs", async () => {
    const sr = await openReplay(await tmp());
    await expect(sr.setState("", { step: "X", status: "PENDING" })).rejects.toBeInstanceOf(
      StateReplayValidationError,
    );
    await expect(sr.setState("id", { step: "", status: "PENDING" })).rejects.toBeInstanceOf(
      StateReplayValidationError,
    );
    await expect(
      sr.setState("id", { step: "X", status: "NOPE" as unknown as "PENDING" }),
    ).rejects.toBeInstanceOf(StateReplayValidationError);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      sr.setState("id", { step: "X", status: "PENDING", data: circular as unknown as JobData }),
    ).rejects.toBeInstanceOf(StateReplayValidationError);
    await sr.close();
  });

  it("throws StateReplayClosedError after close()", async () => {
    const sr = await openReplay(await tmp());
    await sr.close();
    await expect(sr.setState("id", { step: "X", status: "PENDING" })).rejects.toBeInstanceOf(
      StateReplayClosedError,
    );
  });

  it("fires 'change' once per successful setState with correct previous/current", async () => {
    const sr = await openReplay(await tmp());
    const events: StateChangeEvent<JobData>[] = [];
    sr.on("change", (e) => events.push(e));
    await sr.setState("job-1", { step: "INIT", status: "PENDING" });
    await sr.setState("job-1", { step: "PAY", status: "PROCESSING" });
    expect(events).toHaveLength(2);
    expect(events[0]?.previous).toBeNull();
    expect(events[0]?.current.step).toBe("INIT");
    expect(events[1]?.previous?.step).toBe("INIT");
    expect(events[1]?.current.step).toBe("PAY");
    await sr.close();
  });

  it("getStats reflects eventCount, idCount and a non-null lastWriteAt after writes", async () => {
    const sr = await openReplay(await tmp());
    expect(sr.getStats().lastWriteAt).toBeNull();
    await sr.setState("a", { step: "S", status: "PENDING" });
    await sr.setState("b", { step: "S", status: "PENDING" });
    await sr.setState("a", { step: "S2", status: "PROCESSING" });
    const stats = sr.getStats();
    expect(stats.eventCount).toBe(3);
    expect(stats.idCount).toBe(2);
    expect(stats.lastWriteAt).not.toBeNull();
    expect(stats.logSizeBytes).toBeGreaterThan(0);
    await sr.close();
  });

  it("instance A writes, closes; instance B replays to identical state", async () => {
    const dir = await tmp();
    const a = await openReplay(dir);
    await a.setState("job-1", { step: "INIT", status: "PENDING" });
    await a.setState("job-1", { step: "PAY", status: "PROCESSING", data: { amount: 100 } });
    await a.setState("job-2", { step: "DONE", status: "COMPLETED" });
    await a.close();

    const b = await openReplay(dir);
    expect(b.getState("job-1")?.step).toBe("PAY");
    expect(b.getState("job-1")?.status).toBe("PROCESSING");
    expect(b.getState("job-1")?.data?.amount).toBe(100);
    expect(b.getState("job-2")?.status).toBe("COMPLETED");
    expect(b.listIds().sort()).toEqual(["job-1", "job-2"]);
    expect(b.getStats().eventCount).toBe(3);
    await b.close();
  });

  it("getAllStates returns a snapshot of frozen clones", async () => {
    const sr = await openReplay(await tmp());
    await sr.setState("a", { step: "S", status: "PENDING" });
    const all = sr.getAllStates();
    expect(all.size).toBe(1);
    expect(Object.isFrozen(all.get("a"))).toBe(true);
    await sr.close();
  });

  it("createStateReplay rejects when encrypt:true without a secretKey", async () => {
    await expect(
      createStateReplay({ storagePath: await tmp(), lock: false, encrypt: true }),
    ).rejects.toBeInstanceOf(StateReplayConfigError);
  });
});
