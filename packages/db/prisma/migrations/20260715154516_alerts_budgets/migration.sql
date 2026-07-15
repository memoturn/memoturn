-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "window" INTEGER NOT NULL DEFAULT 5,
    "threshold" DOUBLE PRECISION NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT 'gt',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "filter" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertState" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "lastValue" DOUBLE PRECISION,
    "lastFiredAt" TIMESTAMP(3),
    "lastResolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostBudget" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "monthlyUsd" DOUBLE PRECISION NOT NULL,
    "thresholds" JSONB NOT NULL DEFAULT '[0.5,0.8,1.0]',
    "notifiedThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertRule_projectId_enabled_idx" ON "AlertRule"("projectId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AlertState_ruleId_key" ON "AlertState"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "CostBudget_projectId_key" ON "CostBudget"("projectId");

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertState" ADD CONSTRAINT "AlertState_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostBudget" ADD CONSTRAINT "CostBudget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
