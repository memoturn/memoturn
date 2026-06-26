-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "event" TEXT NOT NULL DEFAULT 'score.created',
    "threshold" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Webhook_projectId_event_idx" ON "Webhook"("projectId", "event");

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
