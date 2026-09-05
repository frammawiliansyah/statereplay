import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateReplay } from "../../src/core/StateReplay.js";
import { StateReplayDecryptError, StateReplayValidationError } from "../../src/core/errors.js";
import { createTempStorage, removeTempStorage } from "../helpers/tempDir.js";

const SECRET = "a-very-secret-passphrase";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await createTempStorage();
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => removeTempStorage(d)));
});

function logPath(dir: string): string {
  return join(dir, "events.jsonl");
}

async function readLines(dir: string): Promise<string[]> {
  const raw = await readFile(logPath(dir), "utf8");
  return raw.split("\n").filter((l) => l.length > 0);
}

describe("integration: log tampering", () => {
  it("rejects a ciphertext moved under another id (AAD binds id/ts)", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("job-1", { step: "SAFE", status: "PENDING" });
    await a.setState("job-2", { step: "PAYOUT", status: "SUCCESS" });
    await a.close();

    // Swap the ciphertext of job-2 onto job-1's record, keeping job-1's id.
    const [l1, l2] = await readLines(dir).then((ls) => ls.map((l) => JSON.parse(l)));
    const forged = { ...l1, iv: l2.iv, tag: l2.tag, data: l2.data };
    await writeFile(logPath(dir), `${JSON.stringify(forged)}\n${JSON.stringify(l2)}\n`);

    await expect(
      createStateReplay({
        storagePath: dir,
        lock: false,
        encrypt: true,
        secretKey: SECRET,
        tolerantReplay: false,
      }),
    ).rejects.toBeInstanceOf(StateReplayDecryptError);
  });

  it("rejects a ciphertext replayed under a rewritten timestamp", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("job-1", { step: "PAYOUT", status: "SUCCESS" });
    await a.close();

    const [line] = await readLines(dir).then((ls) => ls.map((l) => JSON.parse(l)));
    await writeFile(logPath(dir), `${JSON.stringify({ ...line, ts: line.ts + 1 })}\n`);

    await expect(
      createStateReplay({
        storagePath: dir,
        lock: false,
        encrypt: true,
        secretKey: SECRET,
        tolerantReplay: false,
      }),
    ).rejects.toBeInstanceOf(StateReplayDecryptError);
  });

  it("refuses an injected plaintext line in an encrypted log", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("job-1", { step: "SAFE", status: "PENDING" });
    await a.close();

    const lines = await readLines(dir);
    const injected = JSON.stringify({
      v: 1,
      id: "job-evil",
      ts: Date.now(),
      payload: { step: "PAYOUT", status: "SUCCESS" },
    });
    await writeFile(logPath(dir), `${lines[0]}\n${injected}\n`);

    // Tolerant mode skips it rather than trusting it.
    const b = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    expect(b.getState("job-evil")).toBeUndefined();
    expect(b.getState("job-1")?.step).toBe("SAFE");
    await b.close();

    await expect(
      createStateReplay({
        storagePath: dir,
        lock: false,
        encrypt: true,
        secretKey: SECRET,
        tolerantReplay: false,
      }),
    ).rejects.toBeInstanceOf(StateReplayDecryptError);
  });

  it("applies setState-grade validation on replay", async () => {
    const dir = await tmp();
    const a = await createStateReplay({ storagePath: dir, lock: false });
    await a.setState("good", { step: "INIT", status: "PENDING" });
    await a.close();

    const lines = await readLines(dir);
    const bogus = [
      { v: 1, id: "bad-status", ts: Date.now(), payload: { step: "X", status: "NOT_A_STATUS" } },
      { v: 1, id: "bad-step", ts: Date.now(), payload: { step: 123, status: "PENDING" } },
      { v: 1, id: "x".repeat(5000), ts: Date.now(), payload: { step: "X", status: "PENDING" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    await writeFile(logPath(dir), `${lines[0]}\n${bogus}\n`);

    const b = await createStateReplay({ storagePath: dir, lock: false });
    expect(b.listIds()).toEqual(["good"]);
    await b.close();

    await expect(
      createStateReplay({ storagePath: dir, lock: false, tolerantReplay: false }),
    ).rejects.toBeInstanceOf(StateReplayValidationError);
  });
});
