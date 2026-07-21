-- CreateTable
CREATE TABLE "TraceState" (
    "projectId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "timestamp" TIMESTAMP(3),
    "userId" TEXT,
    "sessionId" TEXT,
    "release" TEXT,
    "version" TEXT,
    "environment" TEXT,
    "public" BOOLEAN,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" TEXT,
    "input" TEXT,
    "output" TEXT,
    "stateVersion" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceState_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE INDEX "TraceState_projectId_updatedAt_idx" ON "TraceState"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "TraceState" ADD CONSTRAINT "TraceState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
