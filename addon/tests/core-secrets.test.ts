import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretsError,
  createSecretCipher,
  isEncryptedSecret,
  isMasked,
  maskSecret,
  maskSecretRecord,
} from "../src/secrets/crypto.js";

const createdDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pulsar-secrets-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("secret cipher", () => {
  it("round-trips plaintext including unicode and keeps empty values empty", async () => {
    const dir = await newDataDir();
    const cipher = createSecretCipher(dir);
    const envelope = cipher.encrypt("ключ-с-секретом-ABC");
    expect(isEncryptedSecret(envelope)).toBe(true);
    expect(envelope.startsWith("enc:v1:")).toBe(true);
    expect(envelope).not.toContain("секретом");
    expect(cipher.decrypt(envelope)).toBe("ключ-с-секретом-ABC");

    expect(cipher.encrypt("")).toBe("");
    expect(cipher.decrypt("")).toBe("");
  });

  it("is idempotent for already encrypted values and passes plaintext through decrypt", async () => {
    const dir = await newDataDir();
    const cipher = createSecretCipher(dir);
    const envelope = cipher.encrypt("value");
    expect(cipher.encrypt(envelope)).toBe(envelope);
    expect(cipher.decrypt("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("reuses the same master key across instances", async () => {
    const dir = await newDataDir();
    const first = createSecretCipher(dir);
    const envelope = first.encrypt("stable-key-check");
    const keyBefore = await readFile(join(dir, "master.key"), "utf8");

    const second = createSecretCipher(dir);
    expect(second.decrypt(envelope)).toBe("stable-key-check");
    expect(await readFile(join(dir, "master.key"), "utf8")).toBe(keyBefore);
    expect(keyBefore.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects tampered envelopes and foreign keys", async () => {
    const dir = await newDataDir();
    const cipher = createSecretCipher(dir);
    const envelope = cipher.encrypt("tamper-me");
    const tampered = `${envelope.slice(0, -2)}AA`;
    expect(() => cipher.decrypt(tampered)).toThrow(SecretsError);

    const otherDir = await newDataDir();
    const foreign = createSecretCipher(otherDir);
    expect(() => foreign.decrypt(envelope)).toThrow(SecretsError);
  });

  it("reports a malformed master key instead of silently replacing it", async () => {
    const dir = await newDataDir();
    await writeFile(join(dir, "master.key"), "not-a-key", { mode: 0o600 });
    expect(() => createSecretCipher(dir)).toThrow(SecretsError);
  });
});

describe("secret masking", () => {
  it("masks non-empty values and keeps empty ones empty", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("secret")).toBe("***");
    expect(isMasked("***")).toBe(true);
    expect(isMasked("secret")).toBe(false);
    expect(maskSecretRecord({ Authorization: "Bearer x", "X-Empty": "" })).toEqual({
      Authorization: "***",
      "X-Empty": "",
    });
  });
});
