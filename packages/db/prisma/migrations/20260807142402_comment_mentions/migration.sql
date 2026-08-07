-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Comment_projectId_mentions_idx" ON "Comment"("projectId", "mentions");
