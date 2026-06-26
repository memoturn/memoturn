import { prisma } from "@memoturn/db";
import { putBlobObject } from "@memoturn/db/blob";
import { exportTracesJsonl } from "./export.js";

/**
 * Scheduled blob exports — recurring NDJSON dumps of a project's traces to blob
 * storage. A daily worker cron sweeps every enabled config (runAllScheduledExports);
 * the API also exposes a manual "run now". Mirrors the retention feature's shape.
 */
export interface ScheduledExportConfig {
  enabled: boolean;
  environment: string;
  limit: number;
  lastRunAt: string | null;
  lastKey: string;
  lastCount: number;
}

interface ScheduledExportRow {
  enabled: boolean;
  environment: string;
  limit: number;
  lastRunAt: Date | null;
  lastKey: string;
  lastCount: number;
}

const DEFAULTS: ScheduledExportConfig = {
  enabled: false,
  environment: "",
  limit: 1000,
  lastRunAt: null,
  lastKey: "",
  lastCount: 0,
};

function shape(p: ScheduledExportRow): ScheduledExportConfig {
  return {
    enabled: p.enabled,
    environment: p.environment,
    limit: p.limit,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
    lastKey: p.lastKey,
    lastCount: p.lastCount,
  };
}

export async function getScheduledExport(projectId: string): Promise<ScheduledExportConfig> {
  const p = await prisma.scheduledExport.findUnique({ where: { projectId } });
  return p ? shape(p) : DEFAULTS;
}

export interface SetScheduledExportInput {
  enabled?: boolean;
  environment?: string;
  limit?: number;
}

export async function setScheduledExport(
  projectId: string,
  input: SetScheduledExportInput,
): Promise<ScheduledExportConfig> {
  const data = {
    enabled: input.enabled ?? false,
    environment: input.environment ?? "",
    limit: input.limit ?? 1000,
  };
  const p = await prisma.scheduledExport.upsert({
    where: { projectId },
    update: data,
    create: { projectId, ...data },
  });
  return shape(p);
}

export interface ScheduledExportResult {
  projectId: string;
  key: string;
  count: number;
  ranAt: string;
}

/** Run the export for one project now (ignores `enabled` — used by the manual trigger). */
export async function runScheduledExport(projectId: string): Promise<ScheduledExportResult> {
  const cfg = await getScheduledExport(projectId);
  const ndjson = await exportTracesJsonl(projectId, {
    limit: cfg.limit,
    environment: cfg.environment || undefined,
  });
  const count = ndjson ? ndjson.trimEnd().split("\n").filter(Boolean).length : 0;
  const ranAt = new Date();
  const stamp = ranAt.toISOString().replace(/[:.]/g, "-");
  const key = `exports/${projectId}/${ranAt.toISOString().slice(0, 10)}/traces-${stamp}.jsonl`;
  await putBlobObject(key, ndjson, "application/x-ndjson");

  await prisma.scheduledExport.upsert({
    where: { projectId },
    update: { lastRunAt: ranAt, lastKey: key, lastCount: count },
    create: { projectId, lastRunAt: ranAt, lastKey: key, lastCount: count },
  });

  return { projectId, key, count, ranAt: ranAt.toISOString() };
}

/** Run every enabled scheduled export (worker cron). Failures skip that project. */
export async function runAllScheduledExports(): Promise<ScheduledExportResult[]> {
  const configs = await prisma.scheduledExport.findMany({ where: { enabled: true } });
  const results: ScheduledExportResult[] = [];
  for (const c of configs) {
    try {
      results.push(await runScheduledExport(c.projectId));
    } catch {
      // skip a project on failure
    }
  }
  return results;
}
