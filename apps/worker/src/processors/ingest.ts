import { compileModelPrices, type IngestEvent, ingestRequest } from "@memoturn/core";
import { getRawBatch } from "@memoturn/db/blob";
import type { IngestJob } from "@memoturn/db/queue";
import {
  applyMasking,
  compileMaskers,
  dispatchAutomationsBatch,
  dispatchWebhooksBatch,
  forwardEvents,
  listOnlineEvaluators,
  loadMaskingPolicy,
  loadProjectPriceOverrides,
  offloadLargePayload,
  offloadMedia,
  runEvaluator,
} from "@memoturn/server";
import { type TelemetryRowMap, type TelemetryTable, telemetry } from "@memoturn/telemetry";
import type { Job } from "bullmq";
import { mapEvents } from "../mappers.js";
import { inc, logJson, observeInsert } from "../metrics.js";

/** True for errors worth retrying (rate limits / transient upstream failures). */
function isTransient(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b(429|5\d\d|timeout|timed out|econnreset|etimedout|temporarily|rate limit)\b/.test(m);
}

/** Run `fn` with a few backoff retries for transient errors only. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Insert one telemetry table in isolation, recording metrics; throws on failure. */
async function insertTable<T extends TelemetryTable>(table: T, values: TelemetryRowMap[T][]): Promise<void> {
  if (values.length === 0) return;
  const start = Date.now();
  try {
    await telemetry().insertRows(table, values);
    observeInsert(Date.now() - start);
    inc("ingest_rows_total", { table }, values.length);
  } catch (err) {
    inc("ingest_errors_total", { table });
    throw err;
  }
}

/** Stable [0,1) hash of a seed string — for deterministic per-trace sampling. */
function sample(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Online evaluation: for completed traces in this batch (trace-create events that carry
 * an output), run each enabled online evaluator on a sampled fraction. Failures here
 * never fail ingestion.
 */
async function runOnlineEvals(projectId: string, batch: IngestEvent[]): Promise<void> {
  const completed = batch.filter(
    (e): e is Extract<IngestEvent, { type: "trace-create" }> =>
      e.type === "trace-create" && e.body.output !== undefined && e.body.output !== "",
  );
  if (completed.length === 0) return;

  const evaluators = await listOnlineEvaluators(projectId);
  if (evaluators.length === 0) return;

  const evalCompleted: { traceId: string; name: string }[] = [];
  for (const ev of evaluators) {
    for (const t of completed) {
      const trace = t.body;
      if (ev.filterName && !(trace.name ?? "").includes(ev.filterName)) continue;
      if (sample(`${trace.id}:${ev.name}`) >= ev.samplingRate) continue;
      try {
        await withRetry(() =>
          runEvaluator(projectId, ev.name, { traceId: trace.id, input: trace.input, output: trace.output }),
        );
        inc("evaluator_runs_total", { evaluator: ev.name, result: "ok" });
        evalCompleted.push({ traceId: trace.id, name: ev.name });
      } catch (err) {
        // Best-effort: never fail ingestion, but COUNT failures so silent eval gaps surface.
        inc("evaluator_runs_total", { evaluator: ev.name, result: "error" });
        logJson("error", "online-eval failed", {
          evaluator: ev.name,
          projectId,
          traceId: trace.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // One batched dispatch for all completed evals (was one config lookup + POST per eval).
  if (evalCompleted.length > 0) {
    await dispatchAutomationsBatch(projectId, "eval.completed", evalCompleted).catch(() => {});
  }
}

/**
 * Ingest job processor. Re-reads the raw batch from blob storage (the source of
 * truth), validates it, maps events to telemetry rows, and inserts.
 *
 * Cross-batch partial updates are handled by a READ-MERGE: the currently stored rows
 * for every trace/observation id in the batch are fetched and passed to the mapper
 * as bases, so fields a later event leaves unset keep their stored value instead of
 * being overwritten with defaults (events are patches).
 */
export async function processIngest(job: Job<IngestJob>): Promise<void> {
  const { projectId, blobKey } = job.data;

  const raw = await getRawBatch(blobKey);
  if (!raw) throw new Error(`raw batch not found at ${blobKey}`);

  const parsed = ingestRequest.parse(JSON.parse(raw));

  // Offload any inline base64 media (data: URIs) in input/output to blob storage.
  for (const e of parsed.batch) {
    const body = e.body as { input?: unknown; output?: unknown };
    if (body.input !== undefined) body.input = await offloadMedia(projectId, body.input);
    if (body.output !== undefined) body.output = await offloadMedia(projectId, body.output);
  }

  // Redact PII from input/output/metadata per the project's masking policy (before CH).
  const maskingPolicy = await loadMaskingPolicy(projectId);
  if (maskingPolicy.enabled) {
    const maskers = compileMaskers(maskingPolicy);
    for (const e of parsed.batch) {
      const body = e.body as { input?: unknown; output?: unknown; metadata?: unknown };
      if (body.input !== undefined) body.input = applyMasking(body.input, maskers);
      if (body.output !== undefined) body.output = applyMasking(body.output, maskers);
      if (body.metadata !== undefined) body.metadata = applyMasking(body.metadata, maskers);
    }
  }

  // Offload large input/output payloads to blob (AFTER masking) so the telemetry store only
  // keeps a small reference marker — honors the schema's "large payloads live in blob" contract.
  for (const e of parsed.batch) {
    const body = e.body as { input?: unknown; output?: unknown };
    if (body.input !== undefined) body.input = await offloadLargePayload(projectId, body.input);
    if (body.output !== undefined) body.output = await offloadLargePayload(projectId, body.output);
  }

  const priceOverrides = compileModelPrices(await loadProjectPriceOverrides(projectId));

  // Read-merge bases: existing rows for every entity id this batch touches.
  const traceIds = [
    ...new Set(parsed.batch.filter((e) => e.type === "trace-create").map((e) => (e.body as { id: string }).id)),
  ];
  const observationIds = [
    ...new Set(
      parsed.batch
        .filter((e) => e.type !== "trace-create" && e.type !== "score-create")
        .map((e) => (e.body as { id: string }).id),
    ),
  ];
  const store = telemetry();
  const [traceBases, observationBases] = await Promise.all([
    store.getTraceRowsByIds(projectId, traceIds),
    store.getObservationRowsByIds(projectId, observationIds),
  ]);
  const bases = {
    traces: new Map(traceBases.map((r) => [r.id, r])),
    observations: new Map(observationBases.map((r) => [r.id, r])),
  };

  const { traces, observations, scores } = mapEvents(projectId, parsed.batch, priceOverrides, bases);

  // Insert each table independently so one table's failure is isolated and observable.
  // Re-insert on retry is safe — the store's last-writer-wins merge (event_ts) dedupes
  // by entity id.
  const results = await Promise.allSettled([
    insertTable("traces", traces),
    insertTable("observations", observations),
    insertTable("scores", scores),
  ]);
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  inc("ingest_events_total", undefined, parsed.batch.length);
  if (failed.length > 0) {
    // Throw so BullMQ retries the whole job (idempotent). DLQ catches terminal failures.
    const reasons = failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ");
    throw new Error(`telemetry insert failed for ${failed.length} table(s): ${reasons}`);
  }

  logJson("info", "ingest ok", {
    projectId,
    traces: traces.length,
    observations: observations.length,
    scores: scores.length,
  });

  // Fire webhooks + automations + analytics for this batch: one config lookup per
  // channel (not per row), deliveries in parallel. allSettled preserves the
  // best-effort contract — dispatch failures never fail ingestion.
  const scorePayloads = scores.map((s) => ({ traceId: s.trace_id, name: s.name, value: s.value, source: s.source }));
  const completedTraces = traces.filter((t) => t.output);
  await Promise.allSettled([
    dispatchWebhooksBatch(projectId, "score.created", scorePayloads),
    dispatchAutomationsBatch(projectId, "score.created", scorePayloads),
    dispatchAutomationsBatch(
      projectId,
      "trace.created",
      completedTraces.map((t) => ({ traceId: t.id, name: t.name })),
    ),
    forwardEvents(projectId, [
      ...scorePayloads.map((p) => ({ event: "score.created", distinctId: p.traceId, properties: { ...p } })),
      ...completedTraces.map((t) => ({
        event: "trace.created",
        distinctId: t.user_id || t.id,
        properties: { traceId: t.id, name: t.name, environment: t.environment, sessionId: t.session_id },
      })),
    ]),
  ]);

  await runOnlineEvals(projectId, parsed.batch);
}
