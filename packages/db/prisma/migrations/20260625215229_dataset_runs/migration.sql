-- AlterTable
ALTER TABLE "Dataset" ADD COLUMN     "description" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "DatasetRun" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetRunItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "datasetItemId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatasetRun_datasetId_name_key" ON "DatasetRun"("datasetId", "name");

-- CreateIndex
CREATE INDEX "DatasetRunItem_runId_idx" ON "DatasetRunItem"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetRunItem_runId_datasetItemId_key" ON "DatasetRunItem"("runId", "datasetItemId");

-- AddForeignKey
ALTER TABLE "DatasetRun" ADD CONSTRAINT "DatasetRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetRunItem" ADD CONSTRAINT "DatasetRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DatasetRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetRunItem" ADD CONSTRAINT "DatasetRunItem_datasetItemId_fkey" FOREIGN KEY ("datasetItemId") REFERENCES "DatasetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
