-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastStatus" INTEGER;
