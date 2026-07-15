-- AlterTable
ALTER TABLE "Evaluator" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "EvaluatorVersion" (
    "id" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluatorVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvaluatorVersion_evaluatorId_version_key" ON "EvaluatorVersion"("evaluatorId", "version");

-- AddForeignKey
ALTER TABLE "EvaluatorVersion" ADD CONSTRAINT "EvaluatorVersion_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
