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
