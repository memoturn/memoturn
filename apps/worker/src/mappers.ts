import { clampTokens, computeCost, type IngestEvent, type ModelPrice, providerForModel } from "@memoturn/core";
import type { ObservationRow, ScoreWriteRow, TraceRow } from "@memoturn/telemetry";

/**
 * Maps validated ingest events into telemetry-store row shapes. Multiple events for
 * the same entity (e.g. generation-create then generation-update) are merged in
 * timestamp order; the store's last-writer-wins merge then keeps the row with the
 * highest event_ts.
 *
 * Events are PATCHES: fields an event leaves unset keep their previous value. Within
 * a batch that happens via body accumulation; across batches the caller passes the
 * entities' currently stored rows as `bases`, and unset fields fall back to them —
 * without a base, a later partial update would materialize defaults and overwrite
 * the fields set at create time.
 */

const json = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const meta = (v: unknown): string => JSON.stringify(v);

export type { ObservationRow, ScoreWriteRow, TraceRow };

/** Currently stored rows for entities referenced by this batch (read-merge bases). */
export interface RowBases {
  traces?: Map<string, TraceRow>;
  observations?: Map<string, ObservationRow>;
}

export interface MappedRows {
  traces: TraceRow[];
  observations: ObservationRow[];
  scores: ScoreWriteRow[];
}

const OBS_TYPE: Record<string, "SPAN" | "GENERATION" | "EVENT"> = {
  "span-create": "SPAN",
  "span-update": "SPAN",
  "generation-create": "GENERATION",
  "generation-update": "GENERATION",
  "event-create": "EVENT",
};

/** Merge an event's body into an accumulating partial object (last write wins per field). */
function assign<T extends object>(acc: Partial<T>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (acc as Record<string, unknown>)[k] = v;
  }
}

export function mapEvents(
  projectId: string,
  events: IngestEvent[],
  priceOverrides: ModelPrice[] = [],
  bases: RowBases = {},
): MappedRows {
  // Sort by event timestamp so later updates override earlier creates.
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const traceAcc = new Map<string, { body: Record<string, unknown>; event_ts: string }>();
  const obsAcc = new Map<
    string,
    { body: Record<string, unknown>; type: "SPAN" | "GENERATION" | "EVENT"; event_ts: string }
  >();
  const scoreRows: ScoreWriteRow[] = [];

  for (const event of ordered) {
    if (event.type === "trace-create") {
      const existing = traceAcc.get(event.body.id) ?? { body: {}, event_ts: event.timestamp };
      assign(existing.body, event.body);
      existing.event_ts = event.timestamp;
      traceAcc.set(event.body.id, existing);
    } else if (event.type === "score-create") {
      scoreRows.push({
        id: event.body.id,
        project_id: projectId,
        trace_id: event.body.traceId,
        observation_id: event.body.observationId ?? "",
        name: event.body.name,
        timestamp: event.body.timestamp ?? event.timestamp,
        environment: event.body.environment ?? "default",
        source: event.body.source ?? "API",
        data_type: event.body.dataType ?? "NUMERIC",
        value: event.body.value ?? null,
        string_value: event.body.stringValue ?? "",
        comment: event.body.comment ?? "",
        config_id: event.body.configId ?? "",
        event_ts: event.timestamp,
      });
    } else {
      const type = OBS_TYPE[event.type]!;
      const id = (event.body as { id: string }).id;
      const existing = obsAcc.get(id) ?? { body: {}, type, event_ts: event.timestamp };
      assign(existing.body, event.body);
      existing.type = type;
      existing.event_ts = event.timestamp;
      obsAcc.set(id, existing);
    }
  }

  const traces: TraceRow[] = [...traceAcc.values()].map(({ body, event_ts }) => {
    const b = body as Record<string, any>;
    const base = bases.traces?.get(b.id);
    return {
      id: b.id,
      project_id: projectId,
      timestamp: b.timestamp ?? base?.timestamp ?? event_ts,
      name: b.name ?? base?.name ?? "",
      user_id: b.userId ?? base?.user_id ?? "",
      session_id: b.sessionId ?? base?.session_id ?? "",
      release: b.release ?? base?.release ?? "",
      version: b.version ?? base?.version ?? "",
      environment: b.environment ?? base?.environment ?? "default",
      public: b.public !== undefined ? (b.public ? 1 : 0) : (base?.public ?? 0),
      tags: b.tags ?? base?.tags ?? [],
      metadata: b.metadata !== undefined ? meta(b.metadata) : (base?.metadata ?? "{}"),
      input: b.input !== undefined ? json(b.input) : (base?.input ?? ""),
      output: b.output !== undefined ? json(b.output) : (base?.output ?? ""),
      event_ts,
    };
  });

  const observations: ObservationRow[] = [...obsAcc.values()].map(({ body, type, event_ts }) => {
    const b = body as Record<string, any>;
    const base = bases.observations?.get(b.id);
    const model: string = b.model ?? base?.model ?? "";
    // Usage patches at object granularity: when the batch carries usage, recompute
    // tokens + cost against the (possibly inherited) model; otherwise keep the base's.
    let promptTokens: number;
    let completionTokens: number;
    let totalTokens: number;
    let cost: { inputCost: number; outputCost: number; totalCost: number };
    if (b.usage !== undefined || !base) {
      promptTokens = clampTokens(b.usage?.promptTokens);
      completionTokens = clampTokens(b.usage?.completionTokens);
      totalTokens = clampTokens(b.usage?.totalTokens ?? promptTokens + completionTokens);
      const c = computeCost(model, promptTokens, completionTokens, priceOverrides);
      cost = { inputCost: c.inputCost, outputCost: c.outputCost, totalCost: c.totalCost };
    } else {
      promptTokens = base.prompt_tokens;
      completionTokens = base.completion_tokens;
      totalTokens = base.total_tokens;
      cost = { inputCost: base.input_cost, outputCost: base.output_cost, totalCost: base.total_cost };
    }
    const startTime: string = b.startTime ?? base?.start_time ?? event_ts;
    const endTime: string | null = b.endTime ?? base?.end_time ?? null;
    return {
      id: b.id,
      trace_id: b.traceId ?? base?.trace_id,
      project_id: projectId,
      type,
      parent_observation_id: b.parentObservationId ?? base?.parent_observation_id ?? "",
      name: b.name ?? base?.name ?? "",
      start_time: startTime,
      end_time: endTime,
      environment: b.environment ?? base?.environment ?? "default",
      level: b.level ?? base?.level ?? "DEFAULT",
      status_message: b.statusMessage ?? base?.status_message ?? "",
      model,
      provider:
        b.provider ?? (b.model !== undefined || !base ? providerForModel(model, priceOverrides) : base.provider),
      model_parameters: b.modelParameters !== undefined ? meta(b.modelParameters) : (base?.model_parameters ?? "{}"),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      input_cost: cost.inputCost,
      output_cost: cost.outputCost,
      total_cost: cost.totalCost,
      prompt_id: b.promptId ?? base?.prompt_id ?? "",
      prompt_version: b.promptVersion ?? base?.prompt_version ?? "",
      input: b.input !== undefined ? json(b.input) : (base?.input ?? ""),
      output: b.output !== undefined ? json(b.output) : (base?.output ?? ""),
      metadata: b.metadata !== undefined ? meta(b.metadata) : (base?.metadata ?? "{}"),
      latency_ms: endTime ? Math.max(0, Date.parse(endTime) - Date.parse(startTime)) : 0,
      event_ts,
    };
  });

  return { traces, observations, scores: scoreRows };
}
