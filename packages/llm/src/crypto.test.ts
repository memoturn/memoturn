import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeKeyId, decryptSecret, encryptSecret, isEncryptedSecret, keyIdOf, needsReencrypt } from "./crypto.js";

/** Produce a pre-v2 ciphertext exactly as the old module did (SHA-256 key, standard base64). */
function legacyEncrypt(secret: string, plaintext: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

describe("secrets at rest", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEYS", "NODE_ENV"]) saved[k] = process.env[k];
    delete process.env.ENCRYPTION_KEYS;
    process.env.ENCRYPTION_KEY = "old-operator-secret-0123456789";
  });
  afterEach(() => {
    for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEYS", "NODE_ENV"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("writes a v2 envelope naming the active key and round-trips", () => {
    const ct = encryptSecret("sk-live-abc");
    expect(ct.startsWith(`v2.${activeKeyId()}.`)).toBe(true);
    expect(ct.split(".")).toHaveLength(5);
    expect(decryptSecret(ct)).toBe("sk-live-abc");
    expect(isEncryptedSecret(ct)).toBe(true);
    expect(needsReencrypt(ct)).toBe(false);
    expect(isEncryptedSecret("whsec_plaintext")).toBe(false);
  });

  it("still opens legacy SHA-256 ciphertexts and flags them for re-encryption", () => {
    const legacy = legacyEncrypt("old-operator-secret-0123456789", "sk-legacy");
    expect(decryptSecret(legacy)).toBe("sk-legacy");
    expect(needsReencrypt(legacy)).toBe(true);
  });

  it("rotates: a ring of new,old decrypts both generations and encrypts under the new key", () => {
    const oldCt = encryptSecret("under-old");
    const legacy = legacyEncrypt("old-operator-secret-0123456789", "under-old-legacy");
    process.env.ENCRYPTION_KEYS = "new-operator-secret-9876543210,old-operator-secret-0123456789";
    expect(activeKeyId()).toBe(keyIdOf("new-operator-secret-9876543210"));
    expect(decryptSecret(oldCt)).toBe("under-old"); // old key still in the ring
    expect(decryptSecret(legacy)).toBe("under-old-legacy");
    expect(needsReencrypt(oldCt)).toBe(true);
    const rotated = encryptSecret(decryptSecret(oldCt));
    expect(rotated.split(".")[1]).toBe(activeKeyId());
    expect(needsReencrypt(rotated)).toBe(false);
    // Drop the old key: the un-rotated ciphertext is now unreadable, with a clear error.
    process.env.ENCRYPTION_KEYS = "new-operator-secret-9876543210";
    expect(() => decryptSecret(oldCt)).toThrow(/not in ENCRYPTION_KEYS/);
    expect(decryptSecret(rotated)).toBe("under-old");
  });

  it("tampering is detected and production refuses to run without a key", () => {
    const ct = encryptSecret("x");
    const parts = ct.split(".");
    parts[4] = `${parts[4]?.slice(0, -2)}AA`;
    expect(() => decryptSecret(parts.join("."))).toThrow();
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = "production";
    expect(() => encryptSecret("x")).toThrow(/required in production/);
  });
});
