import { prisma } from "@memoturn/db";

/**
 * Audit log — records who did what to which entity, per project. Mutating handlers
 * call recordAudit(); the dashboard lists them. Best-effort: never block the request.
 */
export async function recordAudit(
  projectId: string,
  actor: string,
  action: string,
  target: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { projectId, actor, action, target, metadata: metadata as object } });
  } catch {
    // auditing must not break the operation
  }
}

/**
 * Record an auth-lifecycle event (sign-in, member/role change, invitation, …). These are
 * org/user-scoped, but the audit log is per-project — so we attach the event to a project in
 * the relevant organization (its "default" project, else the earliest), which is where it
 * surfaces in the console's audit view. Missing actor/org are resolved from `userId`.
 * Best-effort and never throws: auditing must never break authentication.
 */
export async function recordAuthAudit(opts: {
  userId?: string | null;
  organizationId?: string | null;
  actor?: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    let organizationId = opts.organizationId ?? null;
    let actor = opts.actor;
    if (opts.userId) {
      if (!actor) {
        const u = await prisma.user.findUnique({ where: { id: opts.userId }, select: { email: true } });
        actor = u?.email ?? opts.userId;
      }
      if (!organizationId) {
        const m = await prisma.member.findFirst({
          where: { userId: opts.userId },
          orderBy: { createdAt: "asc" },
          select: { organizationId: true },
        });
        organizationId = m?.organizationId ?? null;
      }
    }
    if (!organizationId) return; // no org context (e.g. brand-new signup) — nothing to attach to
    const project =
      (await prisma.project.findFirst({ where: { organizationId, slug: "default" }, select: { id: true } })) ??
      (await prisma.project.findFirst({
        where: { organizationId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }));
    if (!project) return;
    await recordAudit(project.id, actor ?? "unknown", `auth.${opts.action}`, opts.target, opts.metadata ?? {});
  } catch {
    // never block auth on an audit failure
  }
}

export async function listAuditLogs(projectId: string, limit = 100) {
  const logs = await prisma.auditLog.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return logs.map((l) => ({
    actor: l.actor,
    action: l.action,
    target: l.target,
    metadata: l.metadata,
    createdAt: l.createdAt.toISOString(),
  }));
}
