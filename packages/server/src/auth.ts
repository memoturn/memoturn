import { prisma, verifySecret } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Validates an SDK request's Basic auth credentials (publicKey:secretKey) and returns
 * the owning projectId. The lookup is cached in Redis for a short TTL so high-volume
 * ingestion doesn't hit Postgres on every batch. Runtime-agnostic (Node/Bun) — takes
 * the decoded credentials, not a framework Request.
 */
const CACHE_TTL_SECONDS = 60;

export interface AuthContext {
  projectId: string;
}

export async function authenticateKeys(publicKey: string, secretKey: string): Promise<AuthContext | null> {
  if (!publicKey || !secretKey) return null;

  const cached = await readCache(publicKey);
  if (cached) {
    return verifySecret(secretKey, cached.secretHash) ? { projectId: cached.projectId } : null;
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { publicKey } });
  if (!apiKey) return null;
  if (!verifySecret(secretKey, apiKey.secretHash)) return null;

  await writeCache(publicKey, { projectId: apiKey.projectId, secretHash: apiKey.secretHash });
  void prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { projectId: apiKey.projectId };
}

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

/** Map a Better Auth org member role (lowercase string) to our WorkspaceRole. */
export function toWorkspaceRole(role: string | null | undefined): WorkspaceRole {
  switch ((role ?? "").toLowerCase()) {
    case "owner":
      return "OWNER";
    case "admin":
      return "ADMIN";
    case "viewer":
      return "VIEWER";
    default:
      return "MEMBER";
  }
}

export interface ProjectAccess {
  projectId: string;
  role: WorkspaceRole;
  organizationId: string;
}

/** List every project a user can access (across their org memberships), with role. */
export async function listUserProjects(userId: string) {
  const members = await prisma.member.findMany({
    where: { userId },
    include: { organization: { include: { projects: { orderBy: { createdAt: "asc" } } } } },
    orderBy: { createdAt: "asc" },
  });
  return members.flatMap((m) =>
    m.organization.projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      organization: m.organization.name,
      role: toWorkspaceRole(m.role),
    })),
  );
}

/**
 * Resolve which project a session request operates on + the user's role there. A
 * requested projectId (project switcher) wins when the user is a member of its org;
 * otherwise the active organization's first project, else the user's first project.
 */
export async function getUserProjectAccess(
  userId: string,
  requestedProjectId?: string,
  activeOrganizationId?: string | null,
): Promise<ProjectAccess | null> {
  if (requestedProjectId) {
    const project = await prisma.project.findUnique({ where: { id: requestedProjectId } });
    if (project) {
      const member = await prisma.member.findUnique({
        where: { organizationId_userId: { userId, organizationId: project.organizationId } },
      });
      if (member)
        return { projectId: project.id, role: toWorkspaceRole(member.role), organizationId: project.organizationId };
    }
  }

  if (activeOrganizationId) {
    const member = await prisma.member.findUnique({
      where: { organizationId_userId: { userId, organizationId: activeOrganizationId } },
    });
    const project = await prisma.project.findFirst({
      where: { organizationId: activeOrganizationId },
      orderBy: { createdAt: "asc" },
    });
    if (member && project)
      return { projectId: project.id, role: toWorkspaceRole(member.role), organizationId: activeOrganizationId };
  }

  const member = await prisma.member.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { organization: { include: { projects: { orderBy: { createdAt: "asc" }, take: 1 } } } },
  });
  const project = member?.organization.projects[0];
  if (!member || !project) return null;
  return { projectId: project.id, role: toWorkspaceRole(member.role), organizationId: member.organizationId };
}

/** @deprecated use getUserProjectAccess */
export async function resolveDefaultProjectForUser(userId: string): Promise<string | null> {
  return (await getUserProjectAccess(userId))?.projectId ?? null;
}

/** Parse a `Basic <base64>` header value into credentials. */
export function parseBasicAuth(header: string | null | undefined): { publicKey: string; secretKey: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { publicKey: decoded.slice(0, idx), secretKey: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

interface CachedKey {
  projectId: string;
  secretHash: string;
}

async function readCache(publicKey: string): Promise<CachedKey | null> {
  try {
    const raw = await redisConnection().get(cacheKey(publicKey));
    return raw ? (JSON.parse(raw) as CachedKey) : null;
  } catch {
    return null;
  }
}

async function writeCache(publicKey: string, value: CachedKey): Promise<void> {
  try {
    await redisConnection().set(cacheKey(publicKey), JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch {
    // cache is best-effort
  }
}

const cacheKey = (publicKey: string) => `memoturn:apikey:${publicKey}`;
