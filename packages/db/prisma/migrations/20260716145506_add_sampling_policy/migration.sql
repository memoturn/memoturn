-- CreateTable
CREATE TABLE "SamplingPolicy" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "rate" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SamplingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SamplingPolicy_projectId_key" ON "SamplingPolicy"("projectId");

-- AddForeignKey
ALTER TABLE "SamplingPolicy" ADD CONSTRAINT "SamplingPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
