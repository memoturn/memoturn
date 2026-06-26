-- Migrate tenancy from Workspace/Membership to the Better Auth organization plugin
-- (Organization/Member/Invitation). Data is preserved: organization.id = workspace.id
-- so existing Project.workspaceId values remain valid as Project.organizationId.

-- CreateTable: organization / member / invitation
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "teamId" TEXT,
    "inviterId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- Session gains the active organization pointer
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" TEXT;

-- Copy existing tenancy data
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    SELECT "id", "name", "slug", "createdAt" FROM "Workspace";
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
    SELECT 'mem_' || "id", "workspaceId", "userId", lower("role"::text), "createdAt" FROM "Membership";

-- Re-point Project from workspaceId -> organizationId
ALTER TABLE "Project" DROP CONSTRAINT "Project_workspaceId_fkey";
DROP INDEX "Project_workspaceId_slug_key";
ALTER TABLE "Project" RENAME COLUMN "workspaceId" TO "organizationId";
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "Project"("organizationId", "slug");
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign keys for the new tables
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop the legacy tenancy tables + enum
DROP TABLE "Membership";
DROP TABLE "Workspace";
DROP TYPE "Role";
