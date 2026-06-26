import { prisma } from "@memoturn/db";

/**
 * Score configs define the allowed scores for a project: a name + data type, plus
 * categories (for CATEGORICAL) or a min/max range (for NUMERIC). They drive the review
 * form and document what scores mean.
 */
export type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN";

export interface CreateScoreConfigInput {
  name: string;
  dataType?: ScoreDataType;
  categories?: string[];
  min?: number | null;
  max?: number | null;
}

interface ConfigShape {
  categories?: string[];
  min?: number | null;
  max?: number | null;
}

function shape(c: { id: string; name: string; dataType: string; config: unknown }) {
  const cfg = (c.config ?? {}) as ConfigShape;
  return {
    id: c.id,
    name: c.name,
    dataType: c.dataType as ScoreDataType,
    categories: cfg.categories ?? [],
    min: cfg.min ?? null,
    max: cfg.max ?? null,
  };
}

export async function createScoreConfig(projectId: string, input: CreateScoreConfigInput) {
  const config: ConfigShape = { categories: input.categories ?? [], min: input.min ?? null, max: input.max ?? null };
  const c = await prisma.scoreConfig.upsert({
    where: { projectId_name: { projectId, name: input.name } },
    update: { dataType: input.dataType ?? "NUMERIC", config: config as object },
    create: { projectId, name: input.name, dataType: input.dataType ?? "NUMERIC", config: config as object },
  });
  return shape(c);
}

export async function listScoreConfigs(projectId: string) {
  const rows = await prisma.scoreConfig.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  return rows.map(shape);
}

export async function deleteScoreConfig(projectId: string, id: string) {
  await prisma.scoreConfig.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}
