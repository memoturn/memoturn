-- CreateTable
CREATE TABLE "DatasetRunner" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInvokedAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "DatasetRunner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatasetRunner_datasetId_key" ON "DatasetRunner"("datasetId");

-- AddForeignKey
ALTER TABLE "DatasetRunner" ADD CONSTRAINT "DatasetRunner_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
