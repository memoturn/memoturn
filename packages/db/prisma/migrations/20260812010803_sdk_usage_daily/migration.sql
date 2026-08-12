-- CreateTable
CREATE TABLE "SdkUsageDaily" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "sdkName" TEXT NOT NULL,
    "sdkVersion" TEXT NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 0,
    "batches" INTEGER NOT NULL DEFAULT 0,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SdkUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SdkUsageDaily_projectId_date_idx" ON "SdkUsageDaily"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SdkUsageDaily_projectId_date_sdkName_sdkVersion_key" ON "SdkUsageDaily"("projectId", "date", "sdkName", "sdkVersion");

-- AddForeignKey
ALTER TABLE "SdkUsageDaily" ADD CONSTRAINT "SdkUsageDaily_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
