-- CreateTable
CREATE TABLE "UsageDaily" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "events" INTEGER NOT NULL DEFAULT 0,
    "traces" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageDaily_projectId_date_idx" ON "UsageDaily"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDaily_projectId_date_key" ON "UsageDaily"("projectId", "date");

-- AddForeignKey
ALTER TABLE "UsageDaily" ADD CONSTRAINT "UsageDaily_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
