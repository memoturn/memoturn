-- CreateTable
CREATE TABLE "ObservationState" (
    "projectId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "type" TEXT,
    "parentObservationId" TEXT,
    "name" TEXT,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "environment" TEXT,
    "level" TEXT,
    "statusMessage" TEXT,
    "model" TEXT,
    "provider" TEXT,
    "modelParameters" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheCreationTokens" INTEGER,
    "promptId" TEXT,
    "promptVersion" TEXT,
    "input" TEXT,
    "output" TEXT,
    "metadata" TEXT,
    "stateVersion" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservationState_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE INDEX "ObservationState_projectId_updatedAt_idx" ON "ObservationState"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ObservationState" ADD CONSTRAINT "ObservationState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
