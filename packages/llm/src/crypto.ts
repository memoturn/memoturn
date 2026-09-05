import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (provider API keys, automation secrets,
 * analytics-sink keys, webhook signing secrets).
 *
 * Envelope v2: `v2.<keyId>.<iv>.<tag>.<ct>` (base64url parts). The data key is derived from
 * the operator secret with scrypt (N=2^15) and a fixed application salt — a passphrase-shaped
 * ENCRYPTION_KEY is no longer one SHA-256 away from the AES key. `keyId` is the first 8 hex
 * of sha256(secret), so a ciphertext names the key that can open it.
 *
 * Key ring + rotation: ENCRYPTION_KEYS (comma-separated, first = ACTIVE) or the single
 * ENCRYPTION_KEY. Encryption always uses the active key; decryption tries the key the
 * envelope names, and for LEGACY ciphertexts (`<iv>.<tag>.<ct>`, SHA-256-derived) every key
 * in the ring. `bun run rotate-secrets` re-encrypts every stored secret under the active
 * key, after which the old key can be dropped from the ring. Rotation is therefore:
 * ENCRYPTION_KEYS="new,old" → restart → rotate-secrets → ENCRYPTION_KEYS="new".
 *
 * The key role is independent of BETTER_AUTH_SECRET — they must not be conflated. In
 * production a key is mandatory (boot validation in @memoturn/server enforces it); the
 * hardcoded fallback is development-only.
 */
const DEV_ENCRYPTION_KEY = "memoturn-dev-encryption-key";
const SCRYPT_SALT = "memoturn:secrets:v2";
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface RingKey {
  id: string;
  v2: Buffer; // scrypt-derived
  legacy: Buffer; // sha256-derived (pre-v2 ciphertexts)
}

let ringCache: { source: string; keys: RingKey[] } | undefined;

function secretsFromEnv(): string[] {
  const list = (process.env.ENCRYPTION_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  const single = process.env.ENCRYPTION_KEY;
  if (single) return [single];
  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY (or ENCRYPTION_KEYS) is required in production to encrypt secrets at rest");
  }
  return [DEV_ENCRYPTION_KEY];
}

export function keyIdOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

function ring(): RingKey[] {
  const secrets = secretsFromEnv();
  const source = secrets.join("\u0000");
  if (ringCache?.source === source) return ringCache.keys;
  const keys = secrets.map((secret) => ({
    id: keyIdOf(secret),
    v2: scryptSync(secret, SCRYPT_SALT, 32, SCRYPT_OPTS),
    legacy: createHash("sha256").update(secret).digest(),
  }));
  ringCache = { source, keys };
  return keys;
}

/** The key id new ciphertexts are written under (the first entry of the ring). */
export function activeKeyId(): string {
  return ring()[0]?.id ?? "";
}

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export function encryptSecret(plaintext: string): string {
  const active = ring()[0] as RingKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.v2, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", active.id, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts[0] === "v2" && parts.length === 5) {
    const [, keyId, ivB, tagB, ctB] = parts as [string, string, string, string, string];
    const key = ring().find((k) => k.id === keyId);
    if (!key) throw new Error(`ciphertext was written under key ${keyId}, which is not in ENCRYPTION_KEYS`);
    return open(key.v2, fromB64u(ivB), fromB64u(tagB), fromB64u(ctB));
  }
  if (parts.length === 3) {
    // Legacy `<iv>.<tag>.<ct>` (standard base64, SHA-256 key): try every key in the ring.
    const [ivB, tagB, ctB] = parts as [string, string, string];
    let lastErr: unknown;
    for (const k of ring()) {
      try {
        return open(k.legacy, Buffer.from(ivB, "base64"), Buffer.from(tagB, "base64"), Buffer.from(ctB, "base64"));
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("invalid ciphertext");
  }
  throw new Error("invalid ciphertext");
}

/** True for anything encryptSecret/legacy produced (vs a plaintext that was never encrypted). */
export function isEncryptedSecret(value: string): boolean {
  const parts = value.split(".");
  return (parts[0] === "v2" && parts.length === 5) || (parts.length === 3 && parts.every((p) => p.length > 0));
}

/** True when a stored ciphertext should be rewritten: legacy format, or a non-active key. */
export function needsReencrypt(value: string): boolean {
  if (!isEncryptedSecret(value)) return false;
  const parts = value.split(".");
  return parts[0] !== "v2" || parts[1] !== activeKeyId();
}

/** Mask a secret for display, e.g. "sk-…a1b2". */
export function maskSecret(secret: string): string {
  return secret.length <= 4 ? "…" : `…${secret.slice(-4)}`;
}
