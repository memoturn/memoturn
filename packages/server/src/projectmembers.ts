import { prisma } from "@memoturn/db";

/**
 * Project-level RBAC management. A `ProjectMember` row assigns a user a role on one project
 * that overrides their org-level role there (elevate or restrict); absence means the org role
 * is inherited. The role resolution itself lives in auth.ts (`getUserProjectAccess`).
 */

const VALID_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type ProjectRole = (typeof VALID_ROLES)[number];

export function isValidProjectRole(role: string): role is ProjectRole {
  return (VALID_ROLES as readonly string[]).includes(role);
}

export interface ProjectMemberRow {
  userId: string;
  email: string;
  name: string;
  orgRole: string;
  /** The per-project override, or null when the user inherits their org role. */
  projectRole: string | null;
}

/** List the project's org members, each annotated with any per-project role override. */
export async function listProjectMembers(projectId: string): Promise<ProjectMemberRow[]> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
  if (!project) return [];
  const [members, overrides] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId: project.organizationId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.projectMember.findMany({ where: { projectId }, select: { userId: true, role: true } }),
  ]);
  const overrideByUser = new Map(overrides.map((o) => [o.userId, o.role]));
  return members.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    orgRole: m.role,
    projectRole: overrideByUser.get(m.userId) ?? null,
  }));
}

/**
 * Assign or update a per-project role override for a user. Throws if the project is missing,
 * the role is invalid, or the user isn't a member of the project's organization (you can't be
 * on a project without belonging to its org).
 */
export async function assignProjectMember(projectId: string, userId: string, role: string): Promise<void> {
  if (!isValidProjectRole(role)) throw new Error(`invalid role: ${role}`);
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
  if (!project) throw new Error("project not found");
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { userId, organizationId: project.organizationId } },
  });
  if (!member) throw new Error("user is not a member of this project's organization");
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: { role },
    create: { projectId, userId, role },
  });
}

/** Remove a user's per-project override — they revert to inheriting their org role. */
export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await prisma.projectMember.deleteMany({ where: { projectId, userId } });
}
