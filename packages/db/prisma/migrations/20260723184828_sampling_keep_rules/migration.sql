-- AlterTable
ALTER TABLE "SamplingPolicy" ADD COLUMN     "keepLatencyMs" INTEGER,
ADD COLUMN     "keepMinCostUsd" DOUBLE PRECISION,
ADD COLUMN     "keepOnError" BOOLEAN NOT NULL DEFAULT false;
