-- AlterTable
ALTER TABLE "Evaluator" ADD COLUMN     "expression" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'LLM';

-- AlterTable
ALTER TABLE "EvaluatorVersion" ADD COLUMN     "expression" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'LLM';
