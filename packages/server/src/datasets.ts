import { prisma } from "@memoturn/db";
import { getScoresByTraceIds, getTraceIO } from "./traces.js";

/**
 * Datasets & experiments. A dataset holds items (input + optional expectedOutput). An
 * experiment "run" links each dataset item to the trace produced by running a task on
 * it; scores attached to those traces (in the telemetry store) are the experiment's results.
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
      runs: {
        include: { _count: { select: { items: true } }, version: { select: { version: true } } },
        orderBy: { createdAt: "desc" },
      },
      versions: { include: { _count: { select: { runs: true } } }, orderBy: { version: "desc" } },
    },
  });
  if (!ds) return null;
  return {
    name: ds.name,
    description: ds.description,
    currentVersion: ds.currentVersion,
    items: ds.items.map((i) => ({
      id: i.id,
      input: i.input,
      expectedOutput: i.expectedOutput,
      metadata: i.metadata,
    })),
    runs: ds.runs.map((r) => ({
      name: r.name,
      itemCount: r._count.items,
      createdAt: r.createdAt.toISOString(),
      version: r.version?.version ?? null,
    })),
    versions: ds.versions.map((v) => ({
      version: v.version,
      label: v.label,
      description: v.description,
      itemCount: v.itemCount,
      runCount: v._count.runs,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

/**
 * Cut an immutable version: freeze the dataset's current DatasetItem working set into a
 * DatasetVersion snapshot (copy-on-write). Returns null if the dataset doesn't exist.
 */
export async function createDatasetVersion(
  projectId: string,
  name: string,
  opts: { label?: string; description?: string } = {},
) {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!ds) return null;
  const version = ds.currentVersion + 1;
  const created = await prisma.$transaction(async (tx) => {
    const dv = await tx.datasetVersion.create({
      data: {
        datasetId: ds.id,
        version,
        label: opts.label ?? `v${version}`,
        description: opts.description ?? "",
        itemCount: ds.items.length,
      },
    });
    if (ds.items.length) {
      await tx.datasetVersionItem.createMany({
        data: ds.items.map((it) => ({
          versionId: dv.id,
          datasetItemId: it.id,
          input: it.input as object,
          expectedOutput: (it.expectedOutput ?? undefined) as object | undefined,
          metadata: (it.metadata ?? {}) as object,
        })),
      });
    }
    await tx.dataset.update({ where: { id: ds.id }, data: { currentVersion: version } });
    return dv;
  });
  return { version: created.version, label: created.label, itemCount: created.itemCount };
}

export async function listDatasetVersions(projectId: string, name: string) {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { versions: { include: { _count: { select: { runs: true } } }, orderBy: { version: "desc" } } },
  });
  if (!ds) return null;
  return ds.versions.map((v) => ({
    version: v.version,
    label: v.label,
    description: v.description,
    itemCount: v.itemCount,
    runCount: v._count.runs,
    createdAt: v.createdAt.toISOString(),
  }));
}

export async function getDatasetVersion(projectId: string, name: string, version: number) {
  const ds = await findDataset(projectId, name);
  if (!ds) return null;
  const dv = await prisma.datasetVersion.findUnique({
    where: { datasetId_version: { datasetId: ds.id, version } },
    include: { items: true },
  });
  if (!dv) return null;
  return {
    version: dv.version,
    label: dv.label,
    description: dv.description,
    items: dv.items.map((i) => ({
      id: i.datasetItemId,
      input: i.input,
      expectedOutput: i.expectedOutput,
      metadata: i.metadata,
    })),
  };
}

/**
 * Resolve the DatasetVersion a run should pin to. An explicit version is looked up;
 * otherwise the dataset's current version is used, auto-cutting a v1 if none exists yet
 * (so every recorded run is reproducible against a frozen snapshot).
 */
async function resolveRunVersionId(
  projectId: string,
  ds: { id: string; name: string; currentVersion: number },
  version?: number,
): Promise<string | null> {
  if (version != null) {
    const dv = await prisma.datasetVersion.findUnique({
      where: { datasetId_version: { datasetId: ds.id, version } },
    });
    return dv?.id ?? null;
  }
  if (ds.currentVersion === 0) {
    await createDatasetVersion(projectId, ds.name);
  }
  const current = await prisma.dataset.findUnique({ where: { id: ds.id }, select: { currentVersion: true } });
  const dv = await prisma.datasetVersion.findUnique({
    where: { datasetId_version: { datasetId: ds.id, version: current?.currentVersion ?? 1 } },
  });
  return dv?.id ?? null;
}

export interface RunLink {
  datasetItemId: string;
  traceId: string;
}

/** Record (or extend) an experiment run linking dataset items to their traces. */
export async function recordRun(
  projectId: string,
  datasetName: string,
  runName: string,
  links: RunLink[],
  version?: number,
) {
  const ds = await findDataset(projectId, datasetName);
  if (!ds) return null;

  const versionId = await resolveRunVersionId(projectId, ds, version);

  const run = await prisma.datasetRun.upsert({
    where: { datasetId_name: { datasetId: ds.id, name: runName } },
    update: { versionId: versionId ?? undefined },
    create: { datasetId: ds.id, name: runName, versionId },
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
export async function getDatasetComparison(projectId: string, name: string, version?: number) {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name } },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      runs: {
        where: version != null ? { version: { version } } : undefined,
        orderBy: { createdAt: "asc" },
        include: { items: true },
      },
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
