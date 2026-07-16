-- CreateTable
CREATE TABLE "guardrailPolicy" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pii" BOOLEAN NOT NULL DEFAULT true,
    "piiAction" TEXT NOT NULL DEFAULT 'redact',
    "builtins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "redactWith" TEXT NOT NULL DEFAULT '[REDACTED]',
    "injection" BOOLEAN NOT NULL DEFAULT true,
    "blockedTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrailPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guardrailPolicy_projectId_key" ON "guardrailPolicy"("projectId");

-- AddForeignKey
ALTER TABLE "guardrailPolicy" ADD CONSTRAINT "guardrailPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
