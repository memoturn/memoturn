/*
  Warnings:

  - You are about to drop the column `outputSchema` on the `Evaluator` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Evaluator" DROP COLUMN "outputSchema",
ADD COLUMN     "scoreCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scoreDataType" TEXT NOT NULL DEFAULT 'NUMERIC',
ADD COLUMN     "scoreName" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "EvaluatorVersion" ADD COLUMN     "scoreCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scoreDataType" TEXT NOT NULL DEFAULT 'NUMERIC',
ADD COLUMN     "scoreName" TEXT NOT NULL DEFAULT '';
