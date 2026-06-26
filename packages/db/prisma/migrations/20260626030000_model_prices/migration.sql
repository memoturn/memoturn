-- CreateTable
CREATE TABLE "ModelPrice" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT '',
    "inputPerMTok" DOUBLE PRECISION NOT NULL,
    "outputPerMTok" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelPrice_projectId_pattern_key" ON "ModelPrice"("projectId", "pattern");

-- AddForeignKey
ALTER TABLE "ModelPrice" ADD CONSTRAINT "ModelPrice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
