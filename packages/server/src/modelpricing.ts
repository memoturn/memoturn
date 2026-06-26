import { MODEL_PRICES, type ModelPriceOverride } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Per-project model price overrides. Overrides win over the built-in registry in
 * @memoturn/core; the worker loads them (cached) at ingest time to populate cost
 * columns. CRUD busts the cache so new prices apply within a batch or two.
 */
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string) => `memoturn:modelprices:${projectId}`;

export interface CreateModelPriceInput {
  pattern: string;
  provider?: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

interface ModelPriceRow {
  id: string;
  pattern: string;
  provider: string;
  inputPerMTok: number;
  outputPerMTok: number;
  createdAt: Date;
}

function shape(p: ModelPriceRow) {
  return {
    id: p.id,
    pattern: p.pattern,
    provider: p.provider,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function listModelPrices(projectId: string) {
  const rows = await prisma.modelPrice.findMany({ where: { projectId }, orderBy: { pattern: "asc" } });
  return rows.map(shape);
}

export interface BuiltinModelPrice {
  pattern: string;
  provider: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

/** The built-in registry, exposed read-only so the UI can show what's overridable. */
export function builtinModelPrices(): BuiltinModelPrice[] {
  return MODEL_PRICES.map((p) => ({
    pattern: p.match.source,
    provider: p.provider,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
  }));
}

export async function createModelPrice(projectId: string, input: CreateModelPriceInput) {
  const row = await prisma.modelPrice.upsert({
    where: { projectId_pattern: { projectId, pattern: input.pattern } },
    update: { provider: input.provider ?? "", inputPerMTok: input.inputPerMTok, outputPerMTok: input.outputPerMTok },
    create: {
      projectId,
      pattern: input.pattern,
      provider: input.provider ?? "",
      inputPerMTok: input.inputPerMTok,
      outputPerMTok: input.outputPerMTok,
    },
  });
  await bustCache(projectId);
  return shape(row);
}

export async function deleteModelPrice(projectId: string, id: string) {
  await prisma.modelPrice.deleteMany({ where: { projectId, id } });
  await bustCache(projectId);
  return { deleted: true };
}

/** Load a project's overrides for cost computation (Redis-cached, best-effort). */
export async function loadProjectPriceOverrides(projectId: string): Promise<ModelPriceOverride[]> {
  const cached = await readCache(projectId);
  if (cached) return cached;
  const rows = await prisma.modelPrice.findMany({ where: { projectId } });
  const overrides: ModelPriceOverride[] = rows.map((p) => ({
    pattern: p.pattern,
    provider: p.provider,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
  }));
  await writeCache(projectId, overrides);
  return overrides;
}

async function readCache(projectId: string): Promise<ModelPriceOverride[] | null> {
  try {
    const raw = await redisConnection().get(cacheKey(projectId));
    return raw ? (JSON.parse(raw) as ModelPriceOverride[]) : null;
  } catch {
    return null;
  }
}

async function writeCache(projectId: string, value: ModelPriceOverride[]): Promise<void> {
  try {
    await redisConnection().set(cacheKey(projectId), JSON.stringify(value), "EX", CACHE_TTL_SECONDS);
  } catch {
    // cache is best-effort
  }
}

async function bustCache(projectId: string): Promise<void> {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}
