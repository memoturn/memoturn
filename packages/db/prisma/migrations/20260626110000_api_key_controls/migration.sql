-- Per-key controls: expiry, per-key rate limit, and coarse scopes.
-- Existing keys default to full scopes (read/write/ingest) so they keep working.
ALTER TABLE "ApiKey" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN "rateLimitPerMinute" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read', 'write', 'ingest']::TEXT[];
