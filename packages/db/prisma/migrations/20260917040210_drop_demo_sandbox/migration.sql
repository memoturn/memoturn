/*
  Warnings:

  - You are about to drop the `DemoSandbox` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "DemoSandbox" DROP CONSTRAINT "DemoSandbox_organizationId_fkey";

-- DropTable
DROP TABLE "DemoSandbox";

-- DropEnum
DROP TYPE "DemoSandboxStatus";
