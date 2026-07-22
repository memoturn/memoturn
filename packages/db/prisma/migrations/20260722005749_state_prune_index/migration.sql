-- DropIndex
DROP INDEX "ObservationState_projectId_updatedAt_idx";

-- DropIndex
DROP INDEX "ScoreState_projectId_updatedAt_idx";

-- DropIndex
DROP INDEX "TraceState_projectId_updatedAt_idx";

-- CreateIndex
CREATE INDEX "ObservationState_updatedAt_idx" ON "ObservationState"("updatedAt");

-- CreateIndex
CREATE INDEX "ScoreState_updatedAt_idx" ON "ScoreState"("updatedAt");

-- CreateIndex
CREATE INDEX "TraceState_updatedAt_idx" ON "TraceState"("updatedAt");
