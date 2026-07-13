import { telemetry } from "@memoturn/telemetry";
import { addDatasetItems, createDataset } from "./datasets.js";
import { addReviewItems } from "./review.js";
import { getTraceIO } from "./traces.js";

/**
 * Bulk operations on a selection of traces: delete (telemetry), add-to-dataset
 * (snapshot input/output as items), or enqueue-for-review.
 */
export type BatchAction = "delete" | "add-to-dataset" | "review";

export interface BatchInput {
  action: BatchAction;
  traceIds: string[];
  datasetName?: string;
  queueName?: string;
}

function parseJson(v: string): unknown {
  if (!v) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export async function runBatchAction(projectId: string, input: BatchInput) {
  const ids = input.traceIds.filter(Boolean);
  if (ids.length === 0) return { action: input.action, affected: 0 };

  if (input.action === "delete") {
    await telemetry().deleteTraces(projectId, ids);
    return { action: "delete", affected: ids.length };
  }

  if (input.action === "add-to-dataset") {
    const name = input.datasetName;
    if (!name) return null;
    await createDataset(projectId, { name });
    const io = await getTraceIO(projectId, ids);
    const items = ids
      .map((id) => io.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({ input: parseJson(t.input), expectedOutput: parseJson(t.output), metadata: { traceId: t.id } }));
    const result = await addDatasetItems(projectId, name, items);
    return { action: "add-to-dataset", affected: result?.added ?? 0 };
  }

  if (input.action === "review") {
    const name = input.queueName;
    if (!name) return null;
    const result = await addReviewItems(projectId, name, ids);
    if (!result) return null;
    return { action: "review", affected: result.added };
  }

  return null;
}
