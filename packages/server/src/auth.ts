import { prisma, verifySecret } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Validates an SDK request's Basic auth credentials (publicKey:secretKey) and returns
 * the owning projectId. The lookup is cached in Redis for a short TTL so high-volume
 * ingestion doesn't hit Postgres on every batch. Runtime-agnostic (Node/Bun) — takes
 * the decoded credentials, not a framework Request.
 */
const CACHE_TTL_SECONDS = 60;

export interface AuthContext {
  projectId: string;
}

export async function authenticateKeys(
  publicKey: string,
  secretKey: string,
): Promise<AuthContext | null> {
  if (!publicKey || !secretKey) return null;

  const cached = await readCache(publicKey);
  if (cached) {
    return verifySecret(secretKey, cached.secretHash) ? { projectId: cached.projectId } : null;
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { publicKey } });
  if (!apiKey) return null;
  if (!verifySecret(secretKey, apiKey.secretHash)) return null;

  await writeCache(publicKey, { projectId: apiKey.projectId, secretHash: apiKey.secretHash });
  void prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { projectId: apiKey.projectId };
}

/** Parse a `Basic <base64>` header value into credentials. */
export function parseBasicAuth(header: string | null | undefined): { publicKey: string; secretKey: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { publicKey: decoded.slice(0, idx), secretKey: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

interface CachedKey {
  projectId: string;
  secretHash: string;
}

async function readCache(publicKey: string): Promise<CachedKey | null> {
  try {
    const raw = await redisConnection().get(cacheKey(publicKey));
    return raw ? (JSON.parse(raw) as CachedKey) : null;
  } catch {
    return null;
  }
}

async function writeCache(publicKey: string, value: CachedKey): Promise<void> {
  try {
    await redisConnection().set(cacheKey(publicKey), JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch {
    // cache is best-effort
  }
}

const cacheKey = (publicKey: string) => `memoturn:apikey:${publicKey}`;
