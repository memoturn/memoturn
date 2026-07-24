-- CreateEnum
CREATE TYPE "DemoSandboxStatus" AS ENUM ('PENDING', 'SEEDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "DemoSandbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "DemoSandboxStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "seededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoSandbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoSandbox_organizationId_key" ON "DemoSandbox"("organizationId");

-- CreateIndex
CREATE INDEX "DemoSandbox_expiresAt_idx" ON "DemoSandbox"("expiresAt");

-- CreateIndex
CREATE INDEX "DemoSandbox_userId_idx" ON "DemoSandbox"("userId");

-- AddForeignKey
ALTER TABLE "DemoSandbox" ADD CONSTRAINT "DemoSandbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
