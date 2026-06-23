import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoUtil } from "../../src/core/CryptoUtil.js";
import { StateReplayDecryptError } from "../../src/core/errors.js";

describe("CryptoUtil", () => {
  const salt = randomBytes(16);
  const key = CryptoUtil.resolveKey("correct horse battery staple", salt);

  it("produces a different iv AND data for two encryptions of identical plaintext", () => {
    const a = CryptoUtil.encrypt("transfer-001", key);
    const b = CryptoUtil.encrypt("transfer-001", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("round-trips: decrypt(encrypt(p, k), k) === p", () => {
    const plaintext = JSON.stringify({
      step: "CEX_WITHDRAWAL",
      status: "SUCCESS",
      data: { txHash: "0xabc" },
    });
    const blob = CryptoUtil.encrypt(plaintext, key);
    expect(CryptoUtil.decrypt(blob, key)).toBe(plaintext);
  });

  it("throws StateReplayDecryptError when decrypting with the wrong key", () => {
    const blob = CryptoUtil.encrypt("secret", key);
    const wrongKey = CryptoUtil.resolveKey("a different passphrase", salt);
    expect(() => CryptoUtil.decrypt(blob, wrongKey)).toThrow(StateReplayDecryptError);
  });

  it("throws StateReplayDecryptError when the auth tag is tampered with", () => {
    const blob = CryptoUtil.encrypt("secret", key);
    const tampered = { ...blob, data: Buffer.from("garbage").toString("base64") };
    expect(() => CryptoUtil.decrypt(tampered, key)).toThrow(StateReplayDecryptError);
  });

  describe("resolveKey", () => {
    it("is deterministic for the same (secret, salt) and yields 32 bytes", () => {
      const k1 = CryptoUtil.resolveKey("passphrase", salt);
      const k2 = CryptoUtil.resolveKey("passphrase", salt);
      expect(k1).toHaveLength(32);
      expect(k1.equals(k2)).toBe(true);
    });

    it("derives different keys for different salts", () => {
      const k1 = CryptoUtil.resolveKey("passphrase", randomBytes(16));
      const k2 = CryptoUtil.resolveKey("passphrase", randomBytes(16));
      expect(k1.equals(k2)).toBe(false);
    });

    it("uses a 32-byte Buffer secret directly", () => {
      const raw = randomBytes(32);
      expect(CryptoUtil.resolveKey(raw, salt).equals(raw)).toBe(true);
    });
  });
});
