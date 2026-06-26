-- Annotation assignments: a review item can be assigned to a user.
ALTER TABLE "ReviewItem" ADD COLUMN "assigneeId" TEXT;
CREATE INDEX "ReviewItem_assigneeId_idx" ON "ReviewItem"("assigneeId");
