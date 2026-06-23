import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateReplay, createStateReplay } from "../../src/core/StateReplay.js";
import { StateReplayDecryptError } from "../../src/core/errors.js";
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

describe("integration: encryption", () => {
  it("writes a non-human-readable log and replays it back via decryption", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("transfer-001", {
      step: "CEX_WITHDRAWAL",
      status: "SUCCESS",
      data: { txHash: "0xDEADBEEFsecret" },
    });
    await a.close();

    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    expect(raw).toContain('"enc":true');
    expect(raw).toContain('"alg":"aes-256-gcm"');
    expect(raw).not.toContain("CEX_WITHDRAWAL");
    expect(raw).not.toContain("0xDEADBEEFsecret");

    const b = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    expect(b.getState("transfer-001")?.step).toBe("CEX_WITHDRAWAL");
    expect(b.getState("transfer-001")?.data?.txHash).toBe("0xDEADBEEFsecret");
    await b.close();
  });

  it("fails closed with StateReplayDecryptError on the wrong key (tolerantReplay:false)", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("transfer-001", { step: "PAY", status: "PROCESSING" });
    await a.close();
    await expect(
      createStateReplay({
        storagePath: dir,
        lock: false,
        encrypt: true,
        secretKey: "the-wrong-passphrase",
        tolerantReplay: false,
      }),
    ).rejects.toBeInstanceOf(StateReplayDecryptError);
  });

  it("skips an undecryptable line (tolerant) leaving the id unset, with a non-fatal warning", async () => {
    const dir = await tmp();
    const a = await createStateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: SECRET,
    });
    await a.setState("transfer-001", { step: "PAY", status: "PROCESSING" });
    await a.close();

    const sr = new StateReplay({
      storagePath: dir,
      lock: false,
      encrypt: true,
      secretKey: "the-wrong-passphrase",
    });
    const warnings: Array<{ fatal: boolean }> = [];
    sr.on("replayWarning", (w) => warnings.push(w));
    await sr.init();
    expect(sr.getState("transfer-001")).toBeUndefined();
    expect(warnings.some((w) => w.fatal === false)).toBe(true);
    await sr.close();
  });
});
