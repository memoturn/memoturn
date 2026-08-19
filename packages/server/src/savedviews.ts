import { prisma } from "@memoturn/db";

/** Named, re-applicable sets of table filters (e.g. the traces explorer). */
export interface CreateSavedViewInput {
  table?: string;
  name: string;
  filters: Record<string, unknown>;
}

function serialize(v: { id: string; table: string; name: string; filters: unknown; createdAt: Date }) {
  return {
    id: v.id,
    table: v.table,
    name: v.name,
    filters: (v.filters ?? {}) as Record<string, unknown>,
    createdAt: v.createdAt.toISOString(),
  };
}

export async function createSavedView(projectId: string, input: CreateSavedViewInput) {
  const v = await prisma.savedView.create({
    data: {
      projectId,
      table: input.table ?? "traces",
      name: input.name,
      filters: (input.filters ?? {}) as object,
    },
  });
  return serialize(v);
}

export async function listSavedViews(projectId: string, table = "traces") {
  const rows = await prisma.savedView.findMany({
    where: { projectId, table },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(serialize);
}

/** Update a view's name and/or stored state ("update view with current filters" / rename). */
export async function updateSavedView(
  projectId: string,
  id: string,
  input: { name?: string; filters?: Record<string, unknown> },
) {
  const existing = await prisma.savedView.findFirst({ where: { projectId, id } });
  if (!existing) return null;
  const v = await prisma.savedView.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.filters !== undefined ? { filters: input.filters as object } : {}),
    },
  });
  return serialize(v);
}

export async function deleteSavedView(projectId: string, id: string) {
  await prisma.savedView.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}
