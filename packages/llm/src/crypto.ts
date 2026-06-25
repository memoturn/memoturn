import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for provider API keys at rest. The key is derived from
 * ENCRYPTION_KEY (any length) via SHA-256. Format: base64(iv).base64(tag).base64(ct).
 */
function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET ?? "memoturn-dev-encryption-key";
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("invalid ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Mask a secret for display, e.g. "sk-…a1b2". */
export function maskSecret(secret: string): string {
  return secret.length <= 4 ? "…" : `…${secret.slice(-4)}`;
}
