/**
 * Secret storage primitives: AES-256-GCM encryption with a per-installation master key,
 * plus masking helpers used by API responses and logs.
 *
 * Stored format: "enc:v1:" + base64(iv[12] | tag[16] | ciphertext).
 * Plaintext legacy values are accepted by decrypt() and re-encrypted on the next save.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_MASK = "***";

const ENC_PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_FILE = "master.key";
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export interface SecretCipher {
  /** Encrypts plaintext into "enc:v1:..." envelope. Empty strings and already encrypted values pass through. */
  encrypt(plain: string): string;
  /** Decrypts an envelope; values without the prefix are returned as-is (legacy plaintext). */
  decrypt(stored: string): string;
}

/** Masks a secret for API responses and logs; empty values stay empty. */
export function maskSecret(value: string): string {
  return value.length === 0 ? "" : SECRET_MASK;
}

export function isMasked(value: string): boolean {
  return value === SECRET_MASK;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function maskSecretRecord(values: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) masked[key] = maskSecret(value);
  return masked;
}

/**
 * Loads the 32-byte master key from <dataDir>/master.key, creating it with mode 0600
 * on first start. The key is never regenerated implicitly: losing it makes stored
 * secrets unreadable, so a malformed key is reported instead of being replaced.
 */
export function loadOrCreateMasterKey(dataDir: string): Buffer {
  const file = join(dataDir, MASTER_KEY_FILE);
  if (existsSync(file)) {
    return parseMasterKey(readFileSync(file, "utf8"), file);
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const hex = randomBytes(KEY_BYTES).toString("hex");
  try {
    writeFileSync(file, `${hex}\n`, { mode: 0o600, flag: "wx" });
    return Buffer.from(hex, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process created the key between the check and the write.
      return parseMasterKey(readFileSync(file, "utf8"), file);
    }
    throw err;
  }
}

function parseMasterKey(text: string, file: string): Buffer {
  const hex = text.trim();
  if (!HEX_KEY_RE.test(hex)) {
    throw new SecretsError(
      `Master key ${file} is malformed: expected ${KEY_BYTES * 2} hex characters. Restore it from backup; secrets cannot be decrypted without it.`,
    );
  }
  return Buffer.from(hex, "hex");
}

export function createSecretCipher(dataDir: string): SecretCipher {
  const key = loadOrCreateMasterKey(dataDir);
  return {
    encrypt(plain: string): string {
      if (plain.length === 0 || plain.startsWith(ENC_PREFIX)) return plain;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const envelope = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      return ENC_PREFIX + envelope.toString("base64");
    },
    decrypt(stored: string): string {
      if (stored.length === 0 || !stored.startsWith(ENC_PREFIX)) return stored;
      const envelope = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      if (envelope.length < IV_BYTES + TAG_BYTES) {
        throw new SecretsError("Encrypted secret is corrupted: envelope is too short.");
      }
      const iv = envelope.subarray(0, IV_BYTES);
      const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (err) {
        throw new SecretsError(
          `Encrypted secret cannot be decrypted with the current master key: ${(err as Error).message}`,
        );
      }
    },
  };
}
