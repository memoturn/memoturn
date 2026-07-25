-- AlterTable
ALTER TABLE "Evaluator" ADD COLUMN     "jurors" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "EvaluatorVersion" ADD COLUMN     "jurors" JSONB NOT NULL DEFAULT '[]';
