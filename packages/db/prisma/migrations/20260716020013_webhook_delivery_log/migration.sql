-- CreateTable
CREATE TABLE "webhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhookDelivery_webhookId_createdAt_idx" ON "webhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "webhookDelivery_projectId_createdAt_idx" ON "webhookDelivery"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "webhookDelivery" ADD CONSTRAINT "webhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhookDelivery" ADD CONSTRAINT "webhookDelivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
