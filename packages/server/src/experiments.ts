import type { ExperimentStatus } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { getExperimentQueue } from "@memoturn/db/queue";
import type { ChatMessage, Provider } from "@memoturn/llm";
import { mapConcurrent } from "./concurrency.js";
import { recordRun } from "./datasets.js";
import { runEvaluator } from "./evaluators.js";
import { withLock } from "./lock.js";
import { messagesFromInput, runPlayground } from "./playground.js";
import { type CompiledPrompt, resolvePrompt } from "./prompts.js";

/**
 * Server-executed experiments. Unlike a client-recorded run, the platform itself runs
 * every dataset item through a prompt-version × model, records an output trace per item
 * (via the normal ingest path), auto-scores each with the selected evaluators, and
 * produces a DatasetRun so the existing dataset-comparison view renders the results.
 *
 * Config + lifecycle live in Postgres (Experiment + ExperimentItemResult); outputs and
 * scores live in the telemetry store. The per-item checkpoint (ExperimentItemResult) is
 * the idempotency key: a retried job re-runs only PENDING/FAILED items, so a trace is
 * never double-written for an item already DONE (runPlayground mints fresh trace ids, so
 * merge-on-write would NOT dedupe a re-execution).
 */

const ITEM_CONCURRENCY = Number(process.env.EXPERIMENT_ITEM_CONCURRENCY ?? 4);
const DEFAULT_CHANNEL = "production";

export interface CreateExperimentInput {
  datasetName: string;
  name: string;
  provider?: string;
  model: string;
  params?: Record<string, unknown>;
  promptName?: string;
  promptChannel?: string;
  evaluators?: string[];
}

function summarize(exp: {
  id: string;
  name: string;
  status: ExperimentStatus;
  provider: string;
  model: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: Date;
  dataset: { name: string };
}) {
  return {
    id: exp.id,
    name: exp.name,
    dataset: exp.dataset.name,
    status: exp.status,
    provider: exp.provider,
    model: exp.model,
    totalItems: exp.totalItems,
    completedItems: exp.completedItems,
    failedItems: exp.failedItems,
    createdAt: exp.createdAt.toISOString(),
  };
}

export type CreateExperimentResult =
  | { ok: true; experiment: ReturnType<typeof summarize> }
  | { ok: false; code: "not_found" | "bad_request"; error: string };

/** Create an experiment (one PENDING checkpoint per dataset item) and enqueue the run. */
export async function createExperiment(
  projectId: string,
  input: CreateExperimentInput,
): Promise<CreateExperimentResult> {
  const dataset = await prisma.dataset.findUnique({
    where: { projectId_name: { projectId, name: input.datasetName } },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!dataset) return { ok: false, code: "not_found", error: `dataset "${input.datasetName}" not found` };

  let provider = input.provider ?? "mock";
  const model = input.model;
  const params: Record<string, unknown> = { ...(input.params ?? {}) };
  let promptVersion: number | null = null;

  if (input.promptName) {
    const resolved = await resolvePrompt(projectId, input.promptName, input.promptChannel || DEFAULT_CHANNEL);
    if (!resolved) {
      return {
        ok: false,
        code: "bad_request",
        error: `prompt "${input.promptName}" has no version on the requested channel`,
      };
    }
    promptVersion = resolved.version;
    const cfg = resolved.config ?? {};
    if (!input.provider && typeof cfg.provider === "string") provider = cfg.provider;
    if (params.temperature === undefined && typeof cfg.temperature === "number") params.temperature = cfg.temperature;
    if (params.maxTokens === undefined && typeof cfg.maxTokens === "number") params.maxTokens = cfg.maxTokens;
  }

  const evaluators = input.evaluators ?? [];
  if (evaluators.length) {
    const found = await prisma.evaluator.findMany({
      where: { projectId, name: { in: evaluators } },
      select: { name: true },
    });
    const missing = evaluators.filter((n) => !found.some((f) => f.name === n));
    if (missing.length) return { ok: false, code: "bad_request", error: `unknown evaluators: ${missing.join(", ")}` };
  }

  try {
    const experiment = await prisma.$transaction(async (tx) => {
      const exp = await tx.experiment.create({
        data: {
          projectId,
          datasetId: dataset.id,
          name: input.name,
          provider,
          model,
          params: params as object,
          promptName: input.promptName ?? "",
          promptChannel: input.promptChannel ?? "",
          promptVersion,
          evaluators,
          totalItems: dataset.items.length,
        },
        include: { dataset: { select: { name: true } } },
      });
      if (dataset.items.length) {
        await tx.experimentItemResult.createMany({
          data: dataset.items.map((it) => ({ experimentId: exp.id, datasetItemId: it.id })),
        });
      }
      return exp;
    });

    await getExperimentQueue().add("experiment", { projectId, experimentId: experiment.id });
    return { ok: true, experiment: summarize(experiment) };
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
      return {
        ok: false,
        code: "bad_request",
        error: `an experiment named "${input.name}" already exists for this dataset`,
      };
    }
    throw err;
  }
}

export async function listExperiments(projectId: string) {
  const exps = await prisma.experiment.findMany({
    where: { projectId },
    include: { dataset: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return exps.map(summarize);
}

export async function getExperiment(projectId: string, id: string) {
  const exp = await prisma.experiment.findFirst({
    where: { id, projectId },
    include: { dataset: { select: { name: true } }, items: true },
  });
  if (!exp) return null;
  return {
    ...summarize(exp),
    promptName: exp.promptName,
    promptChannel: exp.promptChannel,
    promptVersion: exp.promptVersion,
    evaluators: exp.evaluators,
    error: exp.error,
    startedAt: exp.startedAt ? exp.startedAt.toISOString() : null,
    completedAt: exp.completedAt ? exp.completedAt.toISOString() : null,
    items: exp.items.map((i) => ({
      datasetItemId: i.datasetItemId,
      status: i.status,
      traceId: i.traceId,
      error: i.error,
    })),
  };
}

/** Cooperatively cancel a PENDING/RUNNING experiment. Returns null if it doesn't exist. */
export async function cancelExperiment(projectId: string, id: string) {
  const exp = await prisma.experiment.findFirst({ where: { id, projectId } });
  if (!exp) return null;
  if (exp.status === "PENDING" || exp.status === "RUNNING") {
    await prisma.experiment.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
  }
  return { id, status: exp.status === "COMPLETED" ? "COMPLETED" : "CANCELLED" };
}

/**
 * Compose the chat messages for one item: the prompt (if any) as a preamble, then the
 * item's own input parsed into messages. A CHAT prompt's messages are prepended; a TEXT
 * prompt becomes a system message. With no prompt the item input is used directly.
 */
function buildMessages(prompt: CompiledPrompt | null, itemInput: unknown): ChatMessage[] {
  const itemMessages = messagesFromInput(itemInput);
  if (!prompt) return itemMessages;
  if (prompt.type === "CHAT" && Array.isArray(prompt.content)) {
    return [...(prompt.content as ChatMessage[]), ...itemMessages];
  }
  const text = typeof prompt.content === "string" ? prompt.content : JSON.stringify(prompt.content);
  return [{ role: "system", content: text }, ...itemMessages];
}

export interface RunExperimentResult {
  ran: boolean;
  reason?: "not_found" | "already_finished" | "locked";
  status?: string;
}

/**
 * Execute (or resume) an experiment. Idempotent under retries via the checkpoint table.
 * Called by the worker processor; also directly drivable in tests.
 */
export async function runExperiment(projectId: string, experimentId: string): Promise<RunExperimentResult> {
  const exp = await prisma.experiment.findFirst({ where: { id: experimentId, projectId }, include: { dataset: true } });
  if (!exp) return { ran: false, reason: "not_found" };
  if (exp.status === "COMPLETED" || exp.status === "CANCELLED")
    return { ran: false, reason: "already_finished", status: exp.status };

  const ran = await withLock(`experiment:${experimentId}`, 30 * 60, async () => {
    const items = await prisma.datasetItem.findMany({
      where: { datasetId: exp.datasetId },
      orderBy: { createdAt: "asc" },
    });
    const checkpoints = await prisma.experimentItemResult.findMany({ where: { experimentId } });
    const cpByItem = new Map(checkpoints.map((c) => [c.datasetItemId, c]));
    const pending = items.filter((it) => {
      const cp = cpByItem.get(it.id);
      return !cp || cp.status === "PENDING" || cp.status === "FAILED";
    });
    const alreadyDone = checkpoints.filter((c) => c.status === "DONE").length;

    // Reset counters from checkpoints so a resume doesn't double-count (FAILED items are
    // back in `pending` and will be re-attempted from zero).
    await prisma.experiment.update({
      where: { id: experimentId },
      data: {
        status: "RUNNING",
        startedAt: exp.startedAt ?? new Date(),
        error: "",
        completedItems: alreadyDone,
        failedItems: 0,
      },
    });

    const prompt = exp.promptName
      ? await resolvePrompt(projectId, exp.promptName, exp.promptChannel || DEFAULT_CHANNEL)
      : null;
    const params = (exp.params ?? {}) as Record<string, unknown>;
    const temperature = typeof params.temperature === "number" ? params.temperature : undefined;
    const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : undefined;

    await mapConcurrent(pending, ITEM_CONCURRENCY, async (item) => {
      // Cooperative cancellation — in-flight items finish, but no new work starts.
      const fresh = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { status: true } });
      if (fresh?.status === "CANCELLED") return;

      const where = { experimentId_datasetItemId: { experimentId, datasetItemId: item.id } };
      await prisma.experimentItemResult.update({ where, data: { status: "RUNNING", attempts: { increment: 1 } } });
      try {
        const messages = buildMessages(prompt, item.input);
        // With { trace: true } the result always carries a traceId (union narrowed).
        const { traceId, content } = (await runPlayground(
          projectId,
          { provider: exp.provider as Provider, model: exp.model, messages, temperature, maxTokens },
          { trace: true },
        )) as { traceId: string; content: string };
        await recordRun(projectId, exp.dataset.name, exp.name, [{ datasetItemId: item.id, traceId }]);
        for (const evName of exp.evaluators) {
          try {
            await runEvaluator(projectId, evName, {
              traceId,
              input: item.input,
              output: content,
              expectedOutput: item.expectedOutput ?? undefined,
            });
          } catch {
            // Evaluation is best-effort — a judge failure never fails the item.
          }
        }
        await prisma.$transaction([
          prisma.experimentItemResult.update({ where, data: { status: "DONE", traceId, error: "" } }),
          prisma.experiment.update({ where: { id: experimentId }, data: { completedItems: { increment: 1 } } }),
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.$transaction([
          prisma.experimentItemResult.update({ where, data: { status: "FAILED", error: message.slice(0, 2000) } }),
          prisma.experiment.update({ where: { id: experimentId }, data: { failedItems: { increment: 1 } } }),
        ]);
      }
    });

    const finalExp = await prisma.experiment.findUnique({ where: { id: experimentId } });
    let status: "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED";
    if (finalExp?.status === "CANCELLED") status = "CANCELLED";
    else if ((finalExp?.totalItems ?? 0) > 0 && (finalExp?.failedItems ?? 0) >= (finalExp?.totalItems ?? 0))
      status = "FAILED";
    await prisma.experiment.update({ where: { id: experimentId }, data: { status, completedAt: new Date() } });
    return status;
  });

  if (ran === null) return { ran: false, reason: "locked" };
  return { ran: true, status: ran };
}
