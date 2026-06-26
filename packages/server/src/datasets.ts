import { prisma } from "@memoturn/db";
import { getScoresByTraceIds, getTraceIO } from "./traces.js";

/**
 * Datasets & experiments. A dataset holds items (input + optional expectedOutput). An
 * experiment "run" links each dataset item to the trace produced by running a task on
 * it; scores attached to those traces (in ClickHouse) are the experiment's results.
 */

async function findDataset(projectId: string, name: string) {
  return prisma.dataset.findUnique({ where: { projectId_name: { projectId, name } } });
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
}

export async function createDataset(projectId: string, input: CreateDatasetInput) {
  const ds = await prisma.dataset.upsert({
    where: { projectId_name: { projectId, name: input.name } },
    update: { description: input.description ?? undefined },
    create: { projectId, name: input.name, description: input.description ?? "" },
  });
  return { id: ds.id, name: ds.name, description: ds.description };
}

export interface DatasetItemInput {
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
}

export async function addDatasetItems(projectId: string, name: string, items: DatasetItemInput[]) {
  const ds = await findDataset(projectId, name);
  if (!ds) return null;
  const created = await prisma.$transaction(
    items.map((it) =>
      prisma.datasetItem.create({
        data: {
          datasetId: ds.id,
          input: it.input as object,
          expectedOutput: (it.expectedOutput ?? undefined) as object | undefined,
          metadata: (it.metadata ?? {}) as object,
        },
      }),
    ),
  );
  return { added: created.length, itemIds: created.map((i) => i.id) };
}

export interface DatasetListItem {
  name: string;
  description: string;
  items: number;
  runs: number;
  createdAt: string;
}

export async function listDatasets(projectId: string): Promise<DatasetListItem[]> {
  const datasets = await prisma.dataset.findMany({
    where: { projectId },
    include: { _count: { select: { items: true, runs: true } } },
    orderBy: { name: "asc" },
  });
  return datasets.map((d) => ({
    name: d.name,
    description: d.description,
    items: d._count.items,
    runs: d._count.runs,
    createdAt: d.createdAt.toISOString(),
  }));
}

export async function getDatasetDetail(projectId: string, name: string) {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name } },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      runs: { include: { _count: { select: { items: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!ds) return null;
  return {
    name: ds.name,
    description: ds.description,
    items: ds.items.map((i) => ({
      id: i.id,
      input: i.input,
      expectedOutput: i.expectedOutput,
      metadata: i.metadata,
    })),
    runs: ds.runs.map((r) => ({ name: r.name, itemCount: r._count.items, createdAt: r.createdAt.toISOString() })),
  };
}

export interface RunLink {
  datasetItemId: string;
  traceId: string;
}

/** Record (or extend) an experiment run linking dataset items to their traces. */
export async function recordRun(projectId: string, datasetName: string, runName: string, links: RunLink[]) {
  const ds = await findDataset(projectId, datasetName);
  if (!ds) return null;

  const run = await prisma.datasetRun.upsert({
    where: { datasetId_name: { datasetId: ds.id, name: runName } },
    update: {},
    create: { datasetId: ds.id, name: runName },
  });

  await prisma.$transaction(
    links.map((l) =>
      prisma.datasetRunItem.upsert({
        where: { runId_datasetItemId: { runId: run.id, datasetItemId: l.datasetItemId } },
        update: { traceId: l.traceId },
        create: { runId: run.id, datasetItemId: l.datasetItemId, traceId: l.traceId },
      }),
    ),
  );

  return { run: run.name, linked: links.length };
}

export interface ExperimentCell {
  traceId: string;
  output: string;
  scores: { name: string; value: number | null; stringValue: string }[];
}

/**
 * Side-by-side comparison of a dataset's runs: every item × every run, with the run's
 * trace output + scores. `cells` is aligned to `runs` (null where a run skipped an item).
 */
export async function getDatasetComparison(projectId: string, name: string) {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name } },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      runs: { orderBy: { createdAt: "asc" }, include: { items: true } },
    },
  });
  if (!ds) return null;

  const traceIds = ds.runs.flatMap((r) => r.items.map((i) => i.traceId)).filter(Boolean);
  const io = await getTraceIO(projectId, traceIds);
  const scoresMap = await getScoresByTraceIds(projectId, traceIds);

  const items = ds.items.map((it) => ({
    id: it.id,
    input: it.input,
    expectedOutput: (it.expectedOutput ?? null) as unknown,
    cells: ds.runs.map((run): ExperimentCell | null => {
      const ri = run.items.find((x) => x.datasetItemId === it.id);
      if (!ri) return null;
      const scores = (scoresMap.get(ri.traceId) ?? []).map((s) => ({
        name: s.name,
        value: s.value,
        stringValue: s.string_value,
      }));
      return { traceId: ri.traceId, output: io.get(ri.traceId)?.output ?? "", scores };
    }),
  }));

  return { dataset: ds.name, runs: ds.runs.map((r) => r.name), items };
}
