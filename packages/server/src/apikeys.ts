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

/**
 * Scopes a key can carry. `read`/`write`/`ingest` are the coarse method/path gate applied
 * by `requiredScope`; `admin` additionally lets the key act as an OWNER on admin-only
 * surfaces (project delete/rename, membership, DLQ replay, key management). It is NEVER
 * granted by default — an API key is a bearer credential, so a stolen default key must
 * not be able to destroy the project or escalate a user's role.
 */
export const DEFAULT_SCOPES = ["read", "write", "ingest"] as const;
export const VALID_SCOPES = [...DEFAULT_SCOPES, "admin"] as const;
const ALL_SCOPES: readonly string[] = DEFAULT_SCOPES;

/**
 * The workspace role an API-key principal acts as. Keys are not org members, so the role
 * is derived from scopes: `admin` → OWNER (admin surfaces), any write/ingest → MEMBER,
 * read-only keys → VIEWER (the method gate already blocks their writes; the role keeps
 * `denyIfReadOnly` consistent with it).
 */
export function roleForScopes(scopes: readonly string[]): "OWNER" | "MEMBER" | "VIEWER" {
  if (scopes.includes("admin")) return "OWNER";
  if (scopes.includes("write") || scopes.includes("ingest")) return "MEMBER";
  return "VIEWER";
}

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

export type Scope = (typeof VALID_SCOPES)[number];

/**
 * The coarse scope a request requires: ingest endpoints, GET reads, everything else writes.
 * `admin` is never *required* here — admin-only routes gate on the derived role via
 * `denyIfNotAdmin`, so an `admin` key still needs `write` for the method gate.
 */
export function requiredScope(method: string, path: string): Exclude<Scope, "admin"> {
  if (path.startsWith("/v1/ingest") || path.startsWith("/v1/otel")) return "ingest";
  return method.toUpperCase() === "GET" ? "read" : "write";
}

/** Normalize create-key options: valid scopes (default read+write+ingest — never admin), expiry, per-key limit. */
/** Default lifetime for a new key when the caller sets none (API_KEY_DEFAULT_EXPIRY_DAYS; unset = no expiry). */
function defaultExpiryDays(): number | null {
  const n = Number(process.env.API_KEY_DEFAULT_EXPIRY_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function resolveKeyControls(input: CreateApiKeyInput, nowMs = Date.now()) {
  const requested = input.scopes?.length
    ? input.scopes.filter((s) => (VALID_SCOPES as readonly string[]).includes(s))
    : [];
  // `expiresInDays: null` is an explicit "never"; undefined falls back to the instance default.
  const days = input.expiresInDays === undefined ? defaultExpiryDays() : input.expiresInDays;
  return {
    scopes: requested.length ? requested : [...ALL_SCOPES],
    expiresAt: days && days > 0 ? new Date(nowMs + days * 86_400_000) : null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? null,
  };
}

/** Mint a new key pair. Returns the plaintext secret once — it is never retrievable again. */
export async function createApiKey(projectId: string, input: CreateApiKeyInput = {}) {
  const pair = generateApiKeyPair();
  const { scopes, expiresAt, rateLimitPerMinute } = resolveKeyControls(input);
  const k = await prisma.apiKey.create({
    data: {
      projectId,
      publicKey: pair.publicKey,
      secretHash: pair.secretHash,
      secretHint: pair.secretHint,
      name: input.name || null,
      scopes,
      expiresAt,
      rateLimitPerMinute,
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
