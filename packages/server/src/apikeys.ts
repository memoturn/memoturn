import { generateApiKeyPair, prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Project-scoped ingestion API keys (pk-mt-… / sk-mt-…). Management surface over the
 * existing ApiKey model that powers SDK/programmatic Basic auth (see auth.ts). The
 * secret is shown once at creation and only its hash + a 4-char hint are stored.
 */
interface ApiKeyRow {
  id: string;
  publicKey: string;
  secretHint: string;
  name: string | null;
  scopes: string[];
  expiresAt: Date | null;
  rateLimitPerMinute: number | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const ALL_SCOPES = ["read", "write", "ingest"];

function shape(k: ApiKeyRow) {
  return {
    id: k.id,
    publicKey: k.publicKey,
    secretHint: k.secretHint,
    name: k.name ?? "",
    scopes: k.scopes,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
    rateLimitPerMinute: k.rateLimitPerMinute,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
  };
}

export async function listApiKeys(projectId: string) {
  const keys = await prisma.apiKey.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  return keys.map(shape);
}

export interface CreateApiKeyInput {
  name?: string;
  scopes?: string[];
  expiresInDays?: number | null;
  rateLimitPerMinute?: number | null;
}

/** Mint a new key pair. Returns the plaintext secret once — it is never retrievable again. */
export async function createApiKey(projectId: string, input: CreateApiKeyInput = {}) {
  const pair = generateApiKeyPair();
  const scopes = (input.scopes?.length ? input.scopes : ALL_SCOPES).filter((s) => ALL_SCOPES.includes(s));
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0 ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const k = await prisma.apiKey.create({
    data: {
      projectId,
      publicKey: pair.publicKey,
      secretHash: pair.secretHash,
      secretHint: pair.secretHint,
      name: input.name || null,
      scopes: scopes.length ? scopes : ALL_SCOPES,
      expiresAt,
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
    },
  });
  return {
    id: k.id,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    secretHint: pair.secretHint,
    name: k.name ?? "",
    scopes: k.scopes,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
    rateLimitPerMinute: k.rateLimitPerMinute,
    createdAt: k.createdAt.toISOString(),
  };
}

/** Revoke a key (scoped to the project) and bust its Redis auth cache so it stops working now. */
export async function revokeApiKey(projectId: string, id: string) {
  const key = await prisma.apiKey.findFirst({ where: { id, projectId } });
  if (!key) return { deleted: false };
  await prisma.apiKey.delete({ where: { id: key.id } });
  try {
    await redisConnection().del(`memoturn:apikey:${key.publicKey}`);
  } catch {
    // cache is best-effort; the entry expires within the TTL regardless
  }
  return { deleted: true };
}
