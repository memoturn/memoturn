-- AlterTable
ALTER TABLE "guardrailPolicy" ADD COLUMN     "judgeModel" TEXT NOT NULL DEFAULT 'mock-1',
ADD COLUMN     "judgeProvider" TEXT NOT NULL DEFAULT 'mock',
ADD COLUMN     "restrictedTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "toxicity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "toxicityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
