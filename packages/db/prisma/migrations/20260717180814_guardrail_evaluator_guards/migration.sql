-- AlterTable
ALTER TABLE "guardrailPolicy" ADD COLUMN     "evaluatorGuards" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "requireMatch" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requireValidJson" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requiredJsonKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sqlInjection" BOOLEAN NOT NULL DEFAULT false;
