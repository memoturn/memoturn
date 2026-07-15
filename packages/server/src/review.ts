import { isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";
import { submitBatch } from "./ingest.js";
import { getTraceIO } from "./traces.js";

/**
 * Human annotation / review queues. A queue holds traces to be manually scored;
 * submitting a review writes an ANNOTATION score through the ingest pipeline (into
 * the telemetry store, alongside API + EVAL scores) and marks the item done.
 */
export interface CreateQueueInput {
  name: string;
  description?: string;
  scoreName: string;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
}

export async function createReviewQueue(projectId: string, input: CreateQueueInput) {
  const q = await prisma.reviewQueue.upsert({
    where: { projectId_name: { projectId, name: input.name } },
    update: {
      description: input.description ?? undefined,
      scoreName: input.scoreName,
      dataType: input.dataType ?? "NUMERIC",
    },
    create: {
      projectId,
      name: input.name,
      description: input.description ?? "",
      scoreName: input.scoreName,
      dataType: input.dataType ?? "NUMERIC",
    },
  });
  return { name: q.name, scoreName: q.scoreName, dataType: q.dataType };
}

export async function listReviewQueues(projectId: string) {
  const queues = await prisma.reviewQueue.findMany({
    where: { projectId },
    include: { items: { select: { status: true } } },
    orderBy: { name: "asc" },
  });
  return queues.map((q) => ({
    name: q.name,
    description: q.description,
    scoreName: q.scoreName,
    dataType: q.dataType,
    pending: q.items.filter((i) => i.status === "PENDING").length,
    done: q.items.filter((i) => i.status === "DONE").length,
  }));
}

/**
 * Review-queue throughput: per-queue counts of items by status (PENDING/DONE/
 * SKIPPED) plus overall totals. Postgres-only (review queues/items live in Prisma).
 */
export async function getReviewAnalytics(projectId: string): Promise<import("@memoturn/contracts").ReviewAnalytics> {
  const queues = await prisma.reviewQueue.findMany({
    where: { projectId },
    include: { items: { select: { status: true } } },
    orderBy: { name: "asc" },
  });

  const perQueue = queues.map((q) => {
    const pending = q.items.filter((i) => i.status === "PENDING").length;
    const done = q.items.filter((i) => i.status === "DONE").length;
    const skipped = q.items.filter((i) => i.status === "SKIPPED").length;
    return { queueName: q.name, pending, done, skipped, total: q.items.length };
  });

  const totals = perQueue.reduce(
    (acc, q) => ({
      pending: acc.pending + q.pending,
      done: acc.done + q.done,
      skipped: acc.skipped + q.skipped,
      total: acc.total + q.total,
    }),
    { pending: 0, done: 0, skipped: 0, total: 0 },
  );

  return { queues: perQueue, totals };
}

async function findQueue(projectId: string, name: string) {
  return prisma.reviewQueue.findUnique({ where: { projectId_name: { projectId, name } } });
}

export async function addReviewItems(projectId: string, name: string, traceIds: string[]) {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  let added = 0;
  for (const traceId of traceIds) {
    await prisma.reviewItem
      .create({ data: { queueId: queue.id, traceId } })
      .then(() => added++)
      .catch(() => {}); // ignore duplicates (unique queueId+traceId)
  }
  return { added };
}

/** Pending items for a queue, enriched with each trace's name/input/output for review. */
export async function listReviewItems(projectId: string, name: string, status = "PENDING", assigneeId?: string) {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  const items = await prisma.reviewItem.findMany({
    where: { queueId: queue.id, status, ...(assigneeId ? { assigneeId } : {}) },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const io = await getTraceIO(
    projectId,
    items.map((i) => i.traceId),
  );
  return {
    queue: { name: queue.name, scoreName: queue.scoreName, dataType: queue.dataType },
    items: items.map((i) => ({
      id: i.id,
      traceId: i.traceId,
      status: i.status,
      assigneeId: i.assigneeId ?? "",
      trace: io.get(i.traceId) ?? { id: i.traceId, name: "", input: "", output: "" },
    })),
  };
}

/** Assign (or unassign, with assigneeId="") a review item to a user. */
export async function assignReviewItem(projectId: string, name: string, itemId: string, assigneeId: string) {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  const item = await prisma.reviewItem.findFirst({ where: { id: itemId, queueId: queue.id } });
  if (!item) return null;
  await prisma.reviewItem.update({ where: { id: item.id }, data: { assigneeId: assigneeId || null } });
  return { itemId: item.id, assigneeId: assigneeId || "" };
}

/**
 * Skip a review item without scoring it: marks the item SKIPPED so it drops out of the pending
 * queue but is still counted in throughput analytics. Returns null when the queue/item is missing.
 */
export async function skipReviewItem(projectId: string, name: string, itemId: string) {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  const item = await prisma.reviewItem.findFirst({ where: { id: itemId, queueId: queue.id } });
  if (!item) return null;
  await prisma.reviewItem.update({ where: { id: item.id }, data: { status: "SKIPPED", completedAt: new Date() } });
  return { itemId: item.id, status: "SKIPPED" as const };
}

export interface ReviewScoreInput {
  value?: number;
  stringValue?: string;
  comment?: string;
}

/** Submit a human score for a review item: writes an ANNOTATION score + marks done. */
export async function submitReviewScore(projectId: string, name: string, itemId: string, score: ReviewScoreInput) {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  const item = await prisma.reviewItem.findFirst({ where: { id: itemId, queueId: queue.id } });
  if (!item) return null;

  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "score-create",
        timestamp: isoNow(),
        body: {
          id: newId(),
          traceId: item.traceId,
          name: queue.scoreName,
          source: "ANNOTATION",
          dataType: queue.dataType as "NUMERIC" | "CATEGORICAL" | "BOOLEAN",
          value: score.value,
          stringValue: score.stringValue,
          comment: score.comment,
          environment: "default",
        },
      },
    ],
  });

  await prisma.reviewItem.update({ where: { id: item.id }, data: { status: "DONE", completedAt: new Date() } });
  return { itemId: item.id, traceId: item.traceId, scoreName: queue.scoreName };
}

// ── Direct trace annotation ─────────────────────────────────────────────────────

export interface AnnotateTraceInput {
  name: string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  value?: number;
  stringValue?: string;
  comment?: string;
}

/**
 * Annotate a trace directly (outside a review queue) — writes an ANNOTATION score through the
 * ingest pipeline, same path as submitReviewScore. The score lands asynchronously in the
 * telemetry store; callers should refetch the trace shortly after.
 */
export async function annotateTrace(projectId: string, traceId: string, input: AnnotateTraceInput) {
  const scoreId = newId();
  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "score-create",
        timestamp: isoNow(),
        body: {
          id: scoreId,
          traceId,
          name: input.name,
          source: "ANNOTATION",
          dataType: input.dataType,
          value: input.value,
          stringValue: input.stringValue,
          comment: input.comment,
          environment: "default",
        },
      },
    ],
  });
  return { scoreId, traceId, name: input.name };
}

// ── Score correction / deletion ───────────────────────────────────────────────

export interface CorrectScoreInput {
  value?: number;
  stringValue?: string;
  comment?: string;
}

/** Shape returned to the API handler after a successful correction. */
export interface CorrectedScore {
  id: string;
  trace_id: string;
  name: string;
  source: string;
  data_type: string;
  value: number | null;
  string_value: string;
  comment: string;
  timestamp: string;
}

/**
 * Correct a score by inserting a replacement row with the same id and a newer
 * event_ts. The telemetry store's last-writer-wins merge keeps the newest row, so
 * this effectively overwrites the old values without a DELETE. Returns null when
 * the score does not exist (route handler maps this to 404).
 */
export async function correctScore(
  projectId: string,
  scoreId: string,
  updates: CorrectScoreInput,
): Promise<CorrectedScore | null> {
  const store = telemetry();
  const existing = await store.getScoreById(projectId, scoreId);
  if (!existing) return null;

  // Merge the caller's patch over the existing fields.
  const newValue = updates.value !== undefined ? updates.value : existing.value;
  const newStringValue = updates.stringValue !== undefined ? updates.stringValue : existing.string_value;
  const newComment = updates.comment !== undefined ? updates.comment : existing.comment;

  // Insert the correction row — same id/trace_id/name, newer event_ts wins the merge.
  await store.insertRows("scores", [
    {
      id: existing.id,
      project_id: projectId,
      trace_id: existing.trace_id,
      observation_id: existing.observation_id,
      name: existing.name,
      timestamp: existing.timestamp,
      environment: existing.environment,
      source: existing.source,
      data_type: existing.data_type,
      value: newValue,
      string_value: newStringValue,
      comment: newComment,
      config_id: existing.config_id,
      event_ts: isoNow(),
    },
  ]);

  return {
    id: existing.id,
    trace_id: existing.trace_id,
    name: existing.name,
    source: existing.source,
    data_type: existing.data_type,
    value: newValue,
    string_value: newStringValue,
    comment: newComment,
    timestamp: existing.timestamp,
  };
}

/**
 * Hard-delete a score. Scoped to project_id to prevent cross-project access.
 * Always returns { deleted: true } — callers that need existence-checking should
 * call correctScore first.
 */
export async function deleteScore(projectId: string, scoreId: string): Promise<{ deleted: boolean }> {
  await telemetry().deleteScore(projectId, scoreId);
  return { deleted: true };
}
