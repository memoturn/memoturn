import { clampTokens, computeCost, type IngestEvent, type ModelPrice, providerForModel } from "@memoturn/core";
import type { ObservationRow, ScoreWriteRow, TraceRow } from "@memoturn/telemetry";

/**
 * Maps validated ingest events into telemetry-store row shapes. Multiple events for
 * the same entity (e.g. generation-create then generation-update) are merged in
 * timestamp order; the store's last-writer-wins merge then keeps the row with the
 * highest event_ts.
 */

const json = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
const meta = (v: unknown): string => (v === undefined ? "{}" : JSON.stringify(v));

export type { ObservationRow, ScoreWriteRow, TraceRow };

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

export function mapEvents(projectId: string, events: IngestEvent[], priceOverrides: ModelPrice[] = []): MappedRows {
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
    return {
      id: b.id,
      project_id: projectId,
      timestamp: b.timestamp ?? event_ts,
      name: b.name ?? "",
      user_id: b.userId ?? "",
      session_id: b.sessionId ?? "",
      release: b.release ?? "",
      version: b.version ?? "",
      environment: b.environment ?? "default",
      public: b.public ? 1 : 0,
      tags: b.tags ?? [],
      metadata: meta(b.metadata),
      input: json(b.input),
      output: json(b.output),
      event_ts,
    };
  });

  const observations: ObservationRow[] = [...obsAcc.values()].map(({ body, type, event_ts }) => {
    const b = body as Record<string, any>;
    const promptTokens = clampTokens(b.usage?.promptTokens);
    const completionTokens = clampTokens(b.usage?.completionTokens);
    const totalTokens = clampTokens(b.usage?.totalTokens ?? promptTokens + completionTokens);
    const cost = computeCost(b.model, promptTokens, completionTokens, priceOverrides);
    const startTime: string = b.startTime ?? event_ts;
    const endTime: string | null = b.endTime ?? null;
    return {
      id: b.id,
      trace_id: b.traceId,
      project_id: projectId,
      type,
      parent_observation_id: b.parentObservationId ?? "",
      name: b.name ?? "",
      start_time: startTime,
      end_time: endTime,
      environment: b.environment ?? "default",
      level: b.level ?? "DEFAULT",
      status_message: b.statusMessage ?? "",
      model: b.model ?? "",
      provider: b.provider ?? providerForModel(b.model, priceOverrides),
      model_parameters: meta(b.modelParameters),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      input_cost: cost.inputCost,
      output_cost: cost.outputCost,
      total_cost: cost.totalCost,
      prompt_id: b.promptId ?? "",
      prompt_version: b.promptVersion ?? "",
      input: json(b.input),
      output: json(b.output),
      metadata: meta(b.metadata),
      latency_ms: endTime ? Math.max(0, Date.parse(endTime) - Date.parse(startTime)) : 0,
      event_ts,
    };
  });

  return { traces, observations, scores: scoreRows };
}
