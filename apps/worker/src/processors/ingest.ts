import { compileModelPrices, type IngestEvent, ingestRequest } from "@memoturn/core";
import { getRawBatch } from "@memoturn/db/blob";
import { clickhouse } from "@memoturn/db/clickhouse";
import type { IngestJob } from "@memoturn/db/queue";
import {
  applyMasking,
  compileMaskers,
  dispatchAutomations,
  dispatchWebhooks,
  forwardEvent,
  listOnlineEvaluators,
  loadMaskingPolicy,
  loadProjectPriceOverrides,
  offloadMedia,
  runEvaluator,
} from "@memoturn/server";
import type { Job } from "bullmq";
import { mapEvents } from "../mappers.js";

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

  for (const ev of evaluators) {
    for (const t of completed) {
      const trace = t.body;
      if (ev.filterName && !(trace.name ?? "").includes(ev.filterName)) continue;
      if (sample(`${trace.id}:${ev.name}`) >= ev.samplingRate) continue;
      try {
        await runEvaluator(projectId, ev.name, { traceId: trace.id, input: trace.input, output: trace.output });
        console.log(`[online-eval] ${ev.name} -> trace ${trace.id}`);
        await dispatchAutomations(projectId, "eval.completed", { traceId: trace.id, name: ev.name });
      } catch (err) {
        console.error(`[online-eval] ${ev.name} failed for ${trace.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

/**
 * Ingest job processor. Re-reads the raw batch from blob storage (the source of
 * truth), validates it, maps events to ClickHouse rows, and inserts.
 *
 * NOTE (Phase 2 hardening): create + update for one observation are merged when they
 * arrive in the same batch. Cross-batch partial updates currently insert a new
 * ReplacingMergeTree row; a read-merge against the existing row will be added so
 * fields set at create time are never lost.
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

  const priceOverrides = compileModelPrices(await loadProjectPriceOverrides(projectId));
  const { traces, observations, scores } = mapEvents(projectId, parsed.batch, priceOverrides);

  const ch = clickhouse();
  await Promise.all([
    traces.length ? ch.insert({ table: "traces", values: traces, format: "JSONEachRow" }) : Promise.resolve(),
    observations.length
      ? ch.insert({ table: "observations", values: observations, format: "JSONEachRow" })
      : Promise.resolve(),
    scores.length ? ch.insert({ table: "scores", values: scores, format: "JSONEachRow" }) : Promise.resolve(),
  ]);

  console.log(
    `[ingest] project=${projectId} traces=${traces.length} observations=${observations.length} scores=${scores.length}`,
  );

  // Fire score.created webhooks + automations + analytics for any scores in this batch.
  for (const s of scores) {
    const payload = { traceId: s.trace_id, name: s.name, value: s.value, source: s.source };
    await dispatchWebhooks(projectId, "score.created", payload);
    await dispatchAutomations(projectId, "score.created", payload);
    await forwardEvent(projectId, "score.created", s.trace_id, payload);
  }

  // Fire trace.created automations + analytics for completed traces (those with an output).
  for (const t of traces) {
    if (t.output) {
      await dispatchAutomations(projectId, "trace.created", { traceId: t.id, name: t.name });
      await forwardEvent(projectId, "trace.created", t.user_id || t.id, {
        traceId: t.id,
        name: t.name,
        environment: t.environment,
        sessionId: t.session_id,
      });
    }
  }

  await runOnlineEvals(projectId, parsed.batch);
}
