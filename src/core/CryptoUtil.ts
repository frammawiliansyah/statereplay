import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { StateReplayDecryptError } from "./errors.js";

/**
 * Per-line payload encryption.
 *
 * AES-256-GCM (AEAD): every `encrypt` uses a fresh random 12-byte IV, so two
 * encryptions of identical plaintext are byte-different. The 16-byte auth tag
 * makes tampering detectable — a wrong key or corrupted ciphertext fails `final()`
 * and is surfaced as {@link StateReplayDecryptError}.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedBlob {
  /** base64, 12 bytes. */
  iv: string;
  /** base64, 16 bytes. */
  tag: string;
  /** base64 ciphertext. */
  data: string;
}

// biome-ignore lint/complexity/noStaticOnlyClass: a cohesive crypto namespace mirrors the spec's `CryptoUtil` API.
export class CryptoUtil {
  /**
   * Derive a 32-byte AES key. A 32-byte Buffer secret is used directly; any
   * other secret (a passphrase string, or a Buffer of a different length) is
   * stretched via scrypt using the per-deployment salt from meta.json.
   * Deterministic for a given `(secret, salt)`.
   */
  static resolveKey(secret: string | Buffer, salt: Buffer): Buffer {
    if (Buffer.isBuffer(secret) && secret.length === KEY_BYTES) {
      return secret;
    }
    return scryptSync(secret, salt, KEY_BYTES);
  }

  /**
   * Associated data binds a ciphertext to the record that carries it. Without
   * it, GCM only proves the payload is intact — not that it belongs here, so an
   * attacker with file-write access could move a valid ciphertext under another
   * `id` and it would decrypt cleanly. Authenticating `v|id|ts` makes that swap
   * fail the tag check.
   */
  static aad(v: number, id: string, ts: number): Buffer {
    return Buffer.from(`${v}|${id}|${ts}`, "utf8");
  }

  static encrypt(plaintext: string, key: Buffer, aad?: Buffer): EncryptedBlob {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    if (aad !== undefined) {
      cipher.setAAD(aad);
    }
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64"),
    };
  }

  static decrypt(blob: EncryptedBlob, key: Buffer, aad?: Buffer): string {
    try {
      const iv = Buffer.from(blob.iv, "base64");
      const tag = Buffer.from(blob.tag, "base64");
      const data = Buffer.from(blob.data, "base64");
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      if (aad !== undefined) {
        decipher.setAAD(aad);
      }
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
      return plaintext.toString("utf8");
    } catch (cause) {
      throw new StateReplayDecryptError("Failed to decrypt payload", { cause });
    }
  }
}
