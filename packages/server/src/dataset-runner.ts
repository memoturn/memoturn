import { randomBytes } from "node:crypto";
import type { DatasetRunner, DatasetRunTrigger } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { isPublicUrl } from "./net.js";
import { signWebhook } from "./webhooks.js";

/**
 * Remote dataset runs — "Run experiment" against a harness that isn't ours.
 *
 * In-platform experiments execute every item through our provider gateway, which locks out
 * every team whose eval harness already exists: they'd have to move their prompts, tools, and
 * retrieval into memoturn just to get a scored run. A dataset can instead register a **runner**
 * — a URL we POST a signed trigger to. Their service runs the items in their own infra, sends
 * traces through normal ingest, and links them back with `POST /v1/dataset-run-items`.
 *
 * The trigger is a POINTER, never a copy of the dataset: it carries the dataset name, run name,
 * version, and item count, and the runner pulls the items with its own API key. That keeps the
 * payload small and bounded no matter how big the dataset is, and means the runner uses the
 * same documented API a human would.
 */

/** How long we wait for the runner to acknowledge the trigger. Their RUN can take hours; the
 *  ack must not. */
const TRIGGER_TIMEOUT_MS = 10_000;

export class DatasetRunnerError extends Error {
  constructor(
    message: string,
    /** true when the caller's input is at fault (→ 400) rather than the remote service. */
    readonly badRequest = true,
  ) {
    super(message);
    this.name = "DatasetRunnerError";
  }
}

function toContract(r: {
  url: string;
  enabled: boolean;
  createdAt: Date;
  lastInvokedAt: Date | null;
  lastStatus: number | null;
  lastError: string;
}): DatasetRunner {
  return {
    url: r.url,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    lastInvokedAt: r.lastInvokedAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

async function findDataset(projectId: string, name: string) {
  return prisma.dataset.findUnique({ where: { projectId_name: { projectId, name } } });
}

export async function getDatasetRunner(projectId: string, datasetName: string): Promise<DatasetRunner | null> {
  const ds = await findDataset(projectId, datasetName);
  if (!ds) return null;
  const runner = await prisma.datasetRunner.findUnique({ where: { datasetId: ds.id } });
  return runner ? toContract(runner) : null;
}

/**
 * Register (or replace) the runner for a dataset. Returns the signing secret ONCE — it is the
 * receiver's only way to verify a trigger really came from us, and we never show it again.
 */
export async function setDatasetRunner(
  projectId: string,
  datasetName: string,
  input: { url: string; enabled?: boolean },
): Promise<(DatasetRunner & { secret: string }) | null> {
  const ds = await findDataset(projectId, datasetName);
  if (!ds) return null;
  // SSRF: the same guard outbound webhooks use — a runner URL is attacker-influenced input
  // that we will POST to from inside the network.
  if (!(await isPublicUrl(input.url))) {
    throw new DatasetRunnerError("runner url must be a public http(s) endpoint");
  }
  const secret = `dsrun_${randomBytes(24).toString("base64url")}`;
  const runner = await prisma.datasetRunner.upsert({
    where: { datasetId: ds.id },
    create: { datasetId: ds.id, url: input.url, secret, enabled: input.enabled ?? true },
    // Re-registering rotates the secret: the URL changed hands, so the old one shouldn't work.
    update: { url: input.url, secret, enabled: input.enabled ?? true, lastError: "" },
  });
  return { ...toContract(runner), secret };
}

export async function deleteDatasetRunner(projectId: string, datasetName: string): Promise<boolean> {
  const ds = await findDataset(projectId, datasetName);
  if (!ds) return false;
  const deleted = await prisma.datasetRunner.deleteMany({ where: { datasetId: ds.id } });
  return deleted.count > 0;
}

/**
 * Fire the trigger. The run row is created FIRST so the run exists in the console the moment
 * it's requested — a run that never comes back is then visibly empty rather than absent, which
 * is the difference between "their harness is slow" and "nothing happened".
 *
 * A non-2xx or unreachable runner is recorded on the runner row and reported to the caller,
 * because unlike a score webhook this is a foreground action someone just clicked.
 */
export async function triggerRemoteRun(
  projectId: string,
  datasetName: string,
  input: { runName: string; version?: number },
): Promise<DatasetRunTrigger> {
  const ds = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name: datasetName } },
    include: { runner: true, _count: { select: { items: true } } },
  });
  if (!ds) throw new DatasetRunnerError(`unknown dataset: ${datasetName}`);
  if (!ds.runner) throw new DatasetRunnerError(`dataset "${datasetName}" has no runner registered`);
  if (!ds.runner.enabled) throw new DatasetRunnerError(`the runner for "${datasetName}" is disabled`);

  const versionId =
    input.version === undefined
      ? null
      : ((
          await prisma.datasetVersion.findUnique({
            where: { datasetId_version: { datasetId: ds.id, version: input.version } },
            select: { id: true },
          })
        )?.id ?? null);
  if (input.version !== undefined && versionId === null) {
    throw new DatasetRunnerError(`dataset "${datasetName}" has no version ${input.version}`);
  }

  const run = await prisma.datasetRun.upsert({
    where: { datasetId_name: { datasetId: ds.id, name: input.runName } },
    create: { datasetId: ds.id, name: input.runName, versionId },
    update: { versionId: versionId ?? undefined },
  });

  const body = JSON.stringify({
    event: "dataset.run.requested",
    projectId,
    dataset: ds.name,
    runName: run.name,
    version: input.version ?? null,
    itemCount: ds._count.items,
    // Pointers, not payloads: the runner pulls items and reports results with its own key.
    itemsUrl: `/v1/datasets/${encodeURIComponent(ds.name)}`,
    resultsUrl: "/v1/dataset-run-items",
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let status: number | null = null;
  let error = "";
  // Re-check at dispatch time, not just at registration: DNS can be rebound in between.
  if (!(await isPublicUrl(ds.runner.url))) {
    error = "runner url did not resolve to a public address";
  } else {
    try {
      const res = await fetch(ds.runner.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "memoturn-dataset-runner/1",
          "x-memoturn-timestamp": timestamp,
          "x-memoturn-signature": signWebhook(ds.runner.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  await prisma.datasetRunner.update({
    where: { datasetId: ds.id },
    data: { lastInvokedAt: new Date(), lastStatus: status, lastError: error },
  });

  return { dataset: ds.name, runName: run.name, itemCount: ds._count.items, accepted: error === "", status, error };
}

/**
 * Attach a trace to a dataset item within a run — how an external harness reports results.
 * The run is created on demand so a runner never has to pre-register one, and the (run, item)
 * pair is upserted so a retried report overwrites rather than duplicating.
 */
export async function recordRunItem(
  projectId: string,
  input: { datasetName: string; runName: string; datasetItemId: string; traceId: string },
): Promise<{ run: string; datasetItemId: string; traceId: string }> {
  const ds = await findDataset(projectId, input.datasetName);
  if (!ds) throw new DatasetRunnerError(`unknown dataset: ${input.datasetName}`);
  // Scoped lookup: an item id from another project (or another dataset) must not be linkable.
  const item = await prisma.datasetItem.findFirst({
    where: { id: input.datasetItemId, datasetId: ds.id },
    select: { id: true },
  });
  if (!item) throw new DatasetRunnerError(`dataset "${input.datasetName}" has no item ${input.datasetItemId}`);

  const run = await prisma.datasetRun.upsert({
    where: { datasetId_name: { datasetId: ds.id, name: input.runName } },
    create: { datasetId: ds.id, name: input.runName },
    update: {},
  });
  await prisma.datasetRunItem.upsert({
    where: { runId_datasetItemId: { runId: run.id, datasetItemId: item.id } },
    create: { runId: run.id, datasetItemId: item.id, traceId: input.traceId },
    update: { traceId: input.traceId },
  });
  return { run: run.name, datasetItemId: item.id, traceId: input.traceId };
}
