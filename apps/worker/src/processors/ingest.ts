import { compileModelPrices, type IngestEvent, ingestRequest } from "@memoturn/core";
import { getRawBatch } from "@memoturn/db/blob";
import type { IngestJob } from "@memoturn/db/queue";
import {
  applyMasking,
  compileMaskers,
  dispatchAutomationsBatch,
  dispatchWebhooksBatch,
  extractObservationPatch,
  extractScorePatch,
  extractTracePatch,
  forwardEvents,
  getSamplingRate,
  listOnlineEvaluators,
  loadMaskingPolicy,
  loadProjectPriceOverrides,
  mergeObservationStates,
  mergeScoreStates,
  mergeTraceStates,
  mutableStateEnabled,
  offloadLargePayload,
  offloadMedia,
  runEvaluator,
  shadowCompareBatch,
  withEntityLocks,
} from "@memoturn/server";
import { type TelemetryRowMap, type TelemetryTable, telemetry } from "@memoturn/telemetry";
import type { Job } from "bullmq";
import { entityLockNames } from "../entitylock.js";
import { mapEvents } from "../mappers.js";
import { inc, logJson, observeInsert } from "../metrics.js";
import { applyHeadSampling, sample } from "../sampling.js";

/** Lock TTL for the read-merge→insert critical section — generous vs the two Doris round trips it
 * covers; if the worker dies mid-batch the lock auto-expires and another replica proceeds. */
const MERGE_LOCK_TTL_SECONDS = 30;

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
 * Ingest job processor. Re-reads the raw batch from blob storage (the source of
 * truth), validates it, maps events to telemetry rows, and inserts.
 *
 * Cross-batch partial updates are handled by a READ-MERGE: the currently stored rows
 * for entity ids the batch may be patching are fetched and passed to the mapper as
 * bases, so fields a later event leaves unset keep their stored value instead of
 * being overwritten with defaults. Update events are patches; an observation *-create
 * is authoritative (no base fetched unless a *-update targets the id cross-batch).
 */
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

  // Read-merge bases: existing rows for every entity id this batch patches.
  // Traces always need a base — trace-create doubles as the update event (the SDK's
  // trace.update() re-emits trace-create with a partial body), so any trace id may be
  // a cross-batch patch. Observations have distinct *-update events: only ids updated
  // WITHOUT a same-batch create can have a stored base worth fetching, so create-only
  // batches (the common SDK flush) skip the observations SELECT entirely.
  const traceIds = [
    ...new Set(parsed.batch.filter((e) => e.type === "trace-create").map((e) => (e.body as { id: string }).id)),
  ];
  const createdObservationIds = new Set(
    parsed.batch
      .filter((e) => e.type === "span-create" || e.type === "generation-create" || e.type === "event-create")
      .map((e) => (e.body as { id: string }).id),
  );
  const observationIds = [
    ...new Set(
      parsed.batch
        .filter((e) => e.type === "span-update" || e.type === "generation-update")
        .map((e) => (e.body as { id: string }).id)
        .filter((id) => !createdObservationIds.has(id)),
    ),
  ];
  const store = telemetry();
  const rate = await getSamplingRate(projectId); // project config — read outside the lock

  // Serialize the read-merge→insert per entity id: without it, two batches patching the same trace
  // each read the same base, materialize a full row from only their own fields, and merge-on-write
  // (LWW) keeps one and drops the other's. Holding per-entity locks makes the second batch read the
  // first's already-written row as its base. Best-effort — degrades to unlocked (counted) if Redis
  // is down or a holder is stuck, rather than stalling ingestion.
  const { traces, observations, scores, retrieval_documents, embeddings } = await withEntityLocks(
    entityLockNames(projectId, parsed.batch),
    MERGE_LOCK_TTL_SECONDS,
    async () => {
      const [traceBases, observationBases] = await Promise.all([
        store.getTraceRowsByIds(projectId, traceIds),
        store.getObservationRowsByIds(projectId, observationIds),
      ]);
      const bases = {
        traces: new Map(traceBases.map((r) => [r.id, r])),
        observations: new Map(observationBases.map((r) => [r.id, r])),
      };

      const mapped = mapEvents(projectId, parsed.batch, priceOverrides, bases);

      // Head-based sampling: keep only rate% of traces in the query store (whole traces, stable per
      // id). The raw batch is already in blob, so dropped traces stay replayable. No-op at rate=100.
      const { rows, dropped } = applyHeadSampling(rate, mapped);
      if (dropped > 0) inc("ingest_sampled_out_total", undefined, dropped);

      // Insert each table independently so one table's failure is isolated and observable.
      // Re-insert on retry is safe — the store's last-writer-wins merge (event_ts) dedupes by id.
      const results = await Promise.allSettled([
        insertTable("traces", rows.traces),
        insertTable("observations", rows.observations),
        insertTable("scores", rows.scores),
        insertTable("retrieval_documents", rows.retrieval_documents),
        insertTable("embeddings", rows.embeddings),
      ]);
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      if (failed.length > 0) {
        // Throw so BullMQ retries the whole job (idempotent). DLQ catches terminal failures.
        const reasons = failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; ");
        throw new Error(`telemetry insert failed for ${failed.length} table(s): ${reasons}`);
      }
      return rows;
    },
    { onDegraded: () => inc("ingest_merge_unlocked_total") },
  );
  inc("ingest_events_total", undefined, parsed.batch.length);

  // ADR-0001 Phase 1: additively merge trace + observation patches into the authoritative
  // Postgres state, alongside the Doris write above. Flag-gated + best-effort — this is a
  // dual-run to validate the merge; a failure here must never affect ingestion.
  if (mutableStateEnabled()) {
    try {
      const tracePatches = [];
      const obsPatches = [];
      const scorePatches = [];
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
      if (tracePatches.length > 0) {
        await mergeTraceStates(projectId, tracePatches);
        inc("mutable_state_merges_total", { entity: "trace" }, tracePatches.length);
      }
      if (obsPatches.length > 0) {
        await mergeObservationStates(projectId, obsPatches);
        inc("mutable_state_merges_total", { entity: "observation" }, obsPatches.length);
      }
      if (scorePatches.length > 0) {
        await mergeScoreStates(projectId, scorePatches);
        inc("mutable_state_merges_total", { entity: "score" }, scorePatches.length);
      }
    } catch (err) {
      inc("mutable_state_errors_total", undefined);
      logJson("error", "mutable-state merge failed (ingestion unaffected)", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Shadow-compare (Phase 2b step 1): verify the mirror-from-Postgres-state row equals the
    // read-merge row this batch just wrote to Doris. Separate best-effort step so a compare hiccup
    // doesn't affect the merge counters; surfaces divergences before Phase 2b removes the read-merge.
    try {
      const results = await shadowCompareBatch(projectId, { traces, observations, scores }, priceOverrides);
      for (const r of results) {
        if (r.matched > 0) inc("mutable_state_shadow_total", { entity: r.entity, result: "match" }, r.matched);
        if (r.mismatched > 0) {
          inc("mutable_state_shadow_total", { entity: r.entity, result: "mismatch" }, r.mismatched);
          logJson("warn", "mutable-state shadow mismatch", {
            projectId,
            entity: r.entity,
            mismatched: r.mismatched,
            samples: r.samples,
          });
        }
        if (r.missing > 0) inc("mutable_state_shadow_total", { entity: r.entity, result: "missing" }, r.missing);
      }
    } catch (err) {
      inc("mutable_state_errors_total", undefined);
      logJson("error", "mutable-state shadow-compare failed (ingestion unaffected)", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
