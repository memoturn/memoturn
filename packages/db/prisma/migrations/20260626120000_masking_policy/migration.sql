-- PII masking: per-project redaction policy applied at ingest.
CREATE TABLE "MaskingPolicy" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "builtins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "redactWith" TEXT NOT NULL DEFAULT '[REDACTED]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaskingPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MaskingPolicy_projectId_key" ON "MaskingPolicy"("projectId");

ALTER TABLE "MaskingPolicy" ADD CONSTRAINT "MaskingPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
