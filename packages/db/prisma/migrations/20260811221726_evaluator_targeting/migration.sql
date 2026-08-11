-- AlterTable
ALTER TABLE "Evaluator" ADD COLUMN     "variableMapping" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "EvaluatorBackfill" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "days" INTEGER NOT NULL DEFAULT 7,
    "filters" JSONB NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EvaluatorBackfill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvaluatorBackfill_projectId_evaluatorId_idx" ON "EvaluatorBackfill"("projectId", "evaluatorId");

-- AddForeignKey
ALTER TABLE "EvaluatorBackfill" ADD CONSTRAINT "EvaluatorBackfill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluatorBackfill" ADD CONSTRAINT "EvaluatorBackfill_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
