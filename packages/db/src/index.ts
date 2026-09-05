import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Shared Prisma client (singleton across hot reloads in dev). Prisma 7 connects via a
 * driver adapter; the connection URL lives here + in prisma.config.ts, not the schema.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
// Pool per replica. With the Helm defaults (api ×2..10 + worker) every replica's Prisma pool
// PLUS its telemetry pool counts against Postgres max_connections (default 100): keep
// Σ replicas × (PRISMA_POOL_SIZE + TELEMETRY_PG_POOL_SIZE) comfortably under it, or front
// Postgres with PgBouncer. See docs/deployment.md#scaling.
const poolSize = Math.min(1000, Math.max(1, Number(process.env.PRISMA_POOL_SIZE) || 10));
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: poolSize,
  connectionTimeoutMillis: Math.max(100, Number(process.env.PRISMA_CONNECT_TIMEOUT_MS) || 10_000),
});
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    // The authoritative mutable-state upsert (server/src/mutablestate.ts) batches many
    // row upserts into ONE transaction; under bulk ingest on a modest DB (e.g. the
    // single-VM Postgres-telemetry tier) those batches can exceed Prisma's aggressive 5s
    // default and dead-letter otherwise-fine events. Give them headroom (env-tunable).
    transactionOptions: {
      timeout: Number(process.env.PRISMA_TRANSACTION_TIMEOUT_MS ?? 20_000),
      maxWait: Number(process.env.PRISMA_TRANSACTION_MAX_WAIT_MS ?? 10_000),
    },
  });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";

// ── API key helpers ──────────────────────────────────────────────────────────────
// Public key is shown in full; the secret is shown once at creation and stored hashed.
export function generateApiKeyPair(): {
  publicKey: string;
  secretKey: string;
  secretHash: string;
  secretHint: string;
} {
  const publicKey = `pk-mt-${randomBytes(16).toString("hex")}`;
  const secretKey = `sk-mt-${randomBytes(24).toString("hex")}`;
  return {
    publicKey,
    secretKey,
    secretHash: hashSecret(secretKey),
    secretHint: secretKey.slice(-4),
  };
}

export function hashSecret(secretKey: string): string {
  return createHash("sha256").update(secretKey).digest("hex");
}

export function verifySecret(secretKey: string, secretHash: string): boolean {
  const a = Buffer.from(hashSecret(secretKey), "hex");
  const b = Buffer.from(secretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
