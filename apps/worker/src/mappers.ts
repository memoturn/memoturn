import { computeCost, type IngestEvent, type ModelPrice, providerForModel } from "@memoturn/core";

/**
 * Maps validated ingest events into ClickHouse row shapes. Multiple events for the
 * same entity (e.g. generation-create then generation-update) are merged in
 * timestamp order; ReplacingMergeTree then keeps the row with the highest event_ts.
 */

const json = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
const meta = (v: unknown): string => (v === undefined ? "{}" : JSON.stringify(v));

export interface TraceRow {
  id: string;
  project_id: string;
  timestamp: string;
  name: string;
  user_id: string;
  session_id: string;
  release: string;
  version: string;
  environment: string;
  public: number;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
  event_ts: string;
}

export interface ObservationRow {
  id: string;
  trace_id: string;
  project_id: string;
  type: "SPAN" | "GENERATION" | "EVENT";
  parent_observation_id: string;
  name: string;
  start_time: string;
  end_time: string | null;
  environment: string;
  level: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  status_message: string;
  model: string;
  provider: string;
  model_parameters: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  prompt_id: string;
  prompt_version: string;
  input: string;
  output: string;
  metadata: string;
  event_ts: string;
}

export interface ScoreRow {
  id: string;
  project_id: string;
  trace_id: string;
  observation_id: string;
  name: string;
  timestamp: string;
  environment: string;
  source: "API" | "EVAL" | "ANNOTATION";
  data_type: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  value: number | null;
  string_value: string;
  comment: string;
  config_id: string;
  event_ts: string;
}

export interface MappedRows {
  traces: TraceRow[];
  observations: ObservationRow[];
  scores: ScoreRow[];
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
  const scoreRows: ScoreRow[] = [];

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
    const promptTokens = b.usage?.promptTokens ?? 0;
    const completionTokens = b.usage?.completionTokens ?? 0;
    const totalTokens = b.usage?.totalTokens ?? promptTokens + completionTokens;
    const cost = computeCost(b.model, promptTokens, completionTokens, priceOverrides);
    return {
      id: b.id,
      trace_id: b.traceId,
      project_id: projectId,
      type,
      parent_observation_id: b.parentObservationId ?? "",
      name: b.name ?? "",
      start_time: b.startTime ?? event_ts,
      end_time: b.endTime ?? null,
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
      event_ts,
    };
  });

  return { traces, observations, scores: scoreRows };
}
