-- Product-analytics sink: per-project PostHog forwarding config.
CREATE TABLE "AnalyticsSink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'posthog',
    "host" TEXT NOT NULL DEFAULT 'https://us.i.posthog.com',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsSink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnalyticsSink_projectId_key" ON "AnalyticsSink"("projectId");

ALTER TABLE "AnalyticsSink" ADD CONSTRAINT "AnalyticsSink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
