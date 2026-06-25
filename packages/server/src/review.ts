import { isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { submitBatch } from "./ingest.js";
import { getTraceIO } from "./traces.js";

/**
 * Human annotation / review queues. A queue holds traces to be manually scored;
 * submitting a review writes an ANNOTATION score through the ingest pipeline (into
 * ClickHouse, alongside API + EVAL scores) and marks the item done.
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
    update: { description: input.description ?? undefined, scoreName: input.scoreName, dataType: input.dataType ?? "NUMERIC" },
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
export async function listReviewItems(projectId: string, name: string, status = "PENDING") {
  const queue = await findQueue(projectId, name);
  if (!queue) return null;
  const items = await prisma.reviewItem.findMany({
    where: { queueId: queue.id, status },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const io = await getTraceIO(projectId, items.map((i) => i.traceId));
  return {
    queue: { name: queue.name, scoreName: queue.scoreName, dataType: queue.dataType },
    items: items.map((i) => ({
      id: i.id,
      traceId: i.traceId,
      status: i.status,
      trace: io.get(i.traceId) ?? { id: i.traceId, name: "", input: "", output: "" },
    })),
  };
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
