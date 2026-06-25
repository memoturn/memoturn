import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared Prisma client (singleton across hot reloads in dev). Prisma 7 connects via a
 * driver adapter; the connection URL lives here + in prisma.config.ts, not the schema.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
export { clickhouse } from "./clickhouse.js";

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
