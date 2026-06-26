-- CreateTable
CREATE TABLE "ScheduledExport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT '',
    "limit" INTEGER NOT NULL DEFAULT 1000,
    "lastRunAt" TIMESTAMP(3),
    "lastKey" TEXT NOT NULL DEFAULT '',
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledExport_projectId_key" ON "ScheduledExport"("projectId");

-- AddForeignKey
ALTER TABLE "ScheduledExport" ADD CONSTRAINT "ScheduledExport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
