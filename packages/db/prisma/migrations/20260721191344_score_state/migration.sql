-- CreateTable
CREATE TABLE "ScoreState" (
    "projectId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "observationId" TEXT,
    "name" TEXT,
    "timestamp" TIMESTAMP(3),
    "environment" TEXT,
    "source" TEXT,
    "dataType" TEXT,
    "value" DOUBLE PRECISION,
    "stringValue" TEXT,
    "comment" TEXT,
    "configId" TEXT,
    "stateVersion" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoreState_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE INDEX "ScoreState_projectId_updatedAt_idx" ON "ScoreState"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ScoreState" ADD CONSTRAINT "ScoreState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
