-- AlterTable
ALTER TABLE "Evaluator" ADD COLUMN     "cooldownSeconds" INTEGER NOT NULL DEFAULT 900,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'trace';
