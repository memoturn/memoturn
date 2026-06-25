-- CreateTable
CREATE TABLE "ReviewQueue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scoreName" TEXT NOT NULL,
    "dataType" TEXT NOT NULL DEFAULT 'NUMERIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewQueue_projectId_name_key" ON "ReviewQueue"("projectId", "name");

-- CreateIndex
CREATE INDEX "ReviewItem_queueId_status_idx" ON "ReviewItem"("queueId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewItem_queueId_traceId_key" ON "ReviewItem"("queueId", "traceId");

-- AddForeignKey
ALTER TABLE "ReviewQueue" ADD CONSTRAINT "ReviewQueue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "ReviewQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
