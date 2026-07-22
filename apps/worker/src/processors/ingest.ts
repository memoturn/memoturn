import { compileModelPrices, type IngestEvent, ingestRequest } from "@memoturn/core";
import { getRawBatch } from "@memoturn/db/blob";
import type { IngestJob } from "@memoturn/db/queue";
import {
  applyMasking,
  compileMaskers,
  dispatchAutomationsBatch,
  dispatchWebhooksBatch,
  existingObservationStateIds,
  existingTraceStateIds,
  extractObservationPatch,
  extractScorePatch,
  extractTracePatch,
  forwardEvents,
  getObservationStates,
  getSamplingRate,
  getScoreStates,
  getTraceStates,
  listOnlineEvaluators,
  loadMaskingPolicy,
  loadProjectPriceOverrides,
  mergeObservationStates,
  mergeScoreStates,
  mergeTraceStates,
  mirrorObservationRow,
  mirrorScoreRow,
  mirrorTraceRow,
  type ObservationPatch,
  offloadLargePayload,
  offloadMedia,
  runEvaluator,
  type ScorePatch,
  seedObservationStates,
  seedTraceStates,
  type TracePatch,
} from "@memoturn/server";
import { type TelemetryRowMap, type TelemetryTable, telemetry } from "@memoturn/telemetry";
import type { Job } from "bullmq";
import { mapEvents } from "../mappers.js";
import { inc, logJson, observeInsert } from "../metrics.js";
import { applyHeadSampling, sample } from "../sampling.js";

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
 * Ingest job processor. Re-reads the raw batch from blob storage (the source of truth), validates
 * it, and applies it.
 *
 * Mutable entities (trace/observation/score) merge field-by-field into their authoritative Postgres
 * `*State` rows (ADR-0001), then Doris is written FROM that merged state (the mirror). This replaces
 * the old Doris read-merge + per-entity lock: Postgres's atomic per-field upsert is what preserves a
 * partial update's omitted fields and prevents the cross-batch lost update. Append-only rows
 * (retrieval documents, embeddings) still come straight from the events.
 */
/**
 * Seed Postgres state from Doris for any entity this batch touches that was pruned from Postgres
 * (Phase 3a) but still lives in Doris — so a late update merges onto the settled state, not an
 * empty row. Cheap in the common case: an id-only presence check, then a Doris read only for the
 * (rare) absent-but-in-Doris ids.
 */
async function rehydratePruned(
  projectId: string,
  tracePatches: TracePatch[],
  obsPatches: ObservationPatch[],
): Promise<void> {
  const traceIds = [...new Set(tracePatches.map((p) => p.id))];
  const obsIds = [...new Set(obsPatches.map((p) => p.id))];
  const [presentTraces, presentObs] = await Promise.all([
    existingTraceStateIds(projectId, traceIds),
    existingObservationStateIds(projectId, obsIds),
  ]);
  const absentTraceIds = traceIds.filter((id) => !presentTraces.has(id));
  const absentObsIds = obsIds.filter((id) => !presentObs.has(id));
  if (absentTraceIds.length === 0 && absentObsIds.length === 0) return;

  const store = telemetry();
  const [dorisTraces, dorisObs] = await Promise.all([
    absentTraceIds.length > 0 ? store.getTraceRowsByIds(projectId, absentTraceIds) : Promise.resolve([]),
    absentObsIds.length > 0 ? store.getObservationRowsByIds(projectId, absentObsIds) : Promise.resolve([]),
  ]);
  if (dorisTraces.length > 0) {
    await seedTraceStates(projectId, dorisTraces);
    inc("mutable_state_rehydrated_total", { entity: "trace" }, dorisTraces.length);
  }
  if (dorisObs.length > 0) {
    await seedObservationStates(projectId, dorisObs);
    inc("mutable_state_rehydrated_total", { entity: "observation" }, dorisObs.length);
  }
}

export async function processIngest(job: Job<IngestJob>): Promise<void> {
  const { projectId, blobKey } = job.data;

  const raw = await getRawBatch(blobKey);
  if (!raw) throw new Error(`raw batch not found at ${blobKey}`);

  // Keep the pre-zod-parse JSON so the mutable-state merge can tell which fields the client
  // actually SENT (present keys) vs. zod-filled defaults — the two diverge (e.g. `environment`).
  const rawJson = JSON.parse(raw) as { batch: Array<{ body?: Record<string, unknown> }> };
  const parsed = ingestRequest.parse(rawJson);

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

  const rate = await getSamplingRate(projectId);

  // ── Authoritative merge into Postgres, then mirror to Doris (ADR-0001) ────────────
  // Each mutable entity (trace/observation/score) merges field-by-field into its Postgres `*State`
  // row — the source of truth. Postgres's atomic upsert prevents the cross-batch lost update, and
  // its per-field merge preserves fields a partial update omits — so there is NO read-merge and NO
  // per-entity lock. Doris is written FROM the merged state (the mirror), ordered by `stateVersion`
  // (its LWW sequence), which is what makes concurrent + out-of-order Doris writes converge.
  const tracePatches: TracePatch[] = [];
  const obsPatches: ObservationPatch[] = [];
  const scorePatches: ScorePatch[] = [];
  for (let i = 0; i < parsed.batch.length; i++) {
    const e = parsed.batch[i]!;
    const rawBody = rawJson.batch[i]?.body ?? {};
    if (e.type === "trace-create") {
      tracePatches.push(extractTracePatch(rawBody, e.body, e.timestamp));
    } else if (
      e.type === "span-create" ||
      e.type === "span-update" ||
      e.type === "generation-create" ||
      e.type === "generation-update" ||
      e.type === "event-create"
    ) {
      obsPatches.push(extractObservationPatch(rawBody, e.body, e.type, e.timestamp));
    } else if (e.type === "score-create") {
      scorePatches.push(extractScorePatch(rawBody, e.body, e.timestamp));
    }
  }
  // Rehydrate (Phase 3b): if an entity this batch touches was pruned from Postgres but still exists
  // in Doris, seed its state from the Doris row before merging so a late update doesn't drop the
  // settled fields. Common case (entity present, or a genuine new create absent from Doris) does no
  // Doris read.
  await rehydratePruned(projectId, tracePatches, obsPatches);

  // Merge is now load-bearing: a failure throws so BullMQ retries the (idempotent) job.
  await mergeTraceStates(projectId, tracePatches);
  await mergeObservationStates(projectId, obsPatches);
  await mergeScoreStates(projectId, scorePatches);
  inc("ingest_events_total", undefined, parsed.batch.length);

  // Build the analytical rows FROM the merged state, computing derived latency/cost. retrieval docs
  // + embeddings are append-only (not mutable state), so they still come straight from the events
  // (mapEvents with no bases — they never needed a read-merge).
  const [traceStates, obsStates, scoreStates] = await Promise.all([
    getTraceStates(projectId, [...new Set(tracePatches.map((p) => p.id))]),
    getObservationStates(projectId, [...new Set(obsPatches.map((p) => p.id))]),
    getScoreStates(projectId, [...new Set(scorePatches.map((p) => p.id))]),
  ]);
  const evented = mapEvents(projectId, parsed.batch, priceOverrides, {});
  const mapped = {
    traces: traceStates.map(mirrorTraceRow),
    observations: obsStates.map((s) => mirrorObservationRow(s, priceOverrides)),
    scores: scoreStates.map(mirrorScoreRow),
    retrieval_documents: evented.retrieval_documents,
    embeddings: evented.embeddings,
  };

  // Head-based sampling: keep only rate% of traces in the analytical store (whole traces, stable per
  // id). Postgres keeps the full authoritative state; only the Doris mirror is sampled. No-op at 100.
  const { rows, dropped } = applyHeadSampling(rate, mapped);
  if (dropped > 0) inc("ingest_sampled_out_total", undefined, dropped);
  const { traces, observations, scores, retrieval_documents, embeddings } = rows;

  // Insert each table independently so one table's failure is isolated and observable. Re-insert on
  // retry is safe — merge-on-write (stateVersion sequence) dedupes by id.
  const results = await Promise.allSettled([
    insertTable("traces", traces),
    insertTable("observations", observations),
    insertTable("scores", scores),
    insertTable("retrieval_documents", retrieval_documents),
    insertTable("embeddings", embeddings),
  ]);
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (failed.length > 0) {
    const reasons = failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ");
    throw new Error(`telemetry insert failed for ${failed.length} table(s): ${reasons}`);
  }

  logJson("info", "ingest ok", {
    projectId,
    traces: traces.length,
    observations: observations.length,
    scores: scores.length,
    retrievalDocs: retrieval_documents.length,
    embeddings: embeddings.length,
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

  // Online evals are best-effort and run AFTER telemetry is committed, so the whole phase is
  // wrapped: a throw here (e.g. the evaluator lookup fails) must not fail the job. If it did,
  // BullMQ would retry the entire batch — re-running evals and re-dispatching webhooks for
  // data that already landed. The invariant is "evals never fail ingestion"; this closes the
  // gap the per-evaluator catch inside runOnlineEvals didn't cover.
  try {
    await runOnlineEvals(projectId, parsed.batch);
  } catch (err) {
    inc("evaluator_runs_total", { evaluator: "*", result: "phase_error" });
    logJson("error", "online-eval phase failed (ingestion unaffected)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
