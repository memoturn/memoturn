import { prisma } from "@memoturn/db";

/**
 * Named dashboards group a project's widgets. The implicit "Default" dashboard (widgets with
 * a null dashboardId) is not a row — the console renders it as a virtual first tab.
 */

export interface CreateDashboardInput {
  name: string;
}

export async function listDashboards(projectId: string) {
  const rows = await prisma.dashboard.findMany({
    where: { projectId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((d) => ({ id: d.id, name: d.name, position: d.position, createdAt: d.createdAt.toISOString() }));
}

export async function createDashboard(projectId: string, input: CreateDashboardInput) {
  const count = await prisma.dashboard.count({ where: { projectId } });
  const d = await prisma.dashboard.create({
    data: { projectId, name: input.name, position: count },
  });
  return { id: d.id, name: d.name, position: d.position, createdAt: d.createdAt.toISOString() };
}

/** Delete a dashboard; its widgets cascade (onDelete: Cascade on Widget.dashboardId). */
export async function deleteDashboard(projectId: string, id: string) {
  await prisma.dashboard.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}
