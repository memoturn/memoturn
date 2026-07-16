-- AlterTable
ALTER TABLE "PromptChannel" ADD COLUMN     "splitVersion" INTEGER,
ADD COLUMN     "splitWeight" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'stable';
