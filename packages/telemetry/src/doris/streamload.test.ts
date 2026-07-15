import { describe, expect, it } from "vitest";
import type { EmbeddingRow, ObservationRow, TraceRow } from "../types.js";
import { streamLoadEnabled, toStreamLoadRecords } from "./streamload.js";

describe("stream load serialization", () => {
  it("formats ISO timestamps to Doris DATETIME and passes arrays through natively", () => {
    const row: TraceRow = {
      id: "t1",
      project_id: "p",
      timestamp: "2026-07-15T01:02:03.456Z",
      name: "n",
      user_id: "u",
      session_id: "s",
      release: "",
      version: "",
      environment: "default",
      public: 0,
      tags: ["a", 'b,"c'],
      metadata: "{}",
      input: "in",
      output: "out",
      event_ts: "2026-07-15T01:02:03.456Z",
    };
    const [rec] = toStreamLoadRecords("traces", [row]);
    expect(rec!.timestamp).toBe("2026-07-15 01:02:03.456");
    expect(rec!.event_ts).toBe("2026-07-15 01:02:03.456");
    // Arrays (tags) ride through as native JSON — no string-CAST corruption.
    expect(rec!.tags).toEqual(["a", 'b,"c']);
    expect(rec!.public).toBe(0);
    expect(rec!.name).toBe("n");
  });

  it("keeps a null end_time null and vectors as numeric arrays", () => {
    const obs = {
      id: "o1",
      trace_id: "t1",
      project_id: "p",
      type: "SPAN",
      parent_observation_id: "",
      name: "",
      start_time: "2026-07-15T00:00:00.000Z",
      end_time: null,
      environment: "default",
      level: "DEFAULT",
      status_message: "",
      model: "",
      provider: "",
      model_parameters: "{}",
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      input_cost: 0,
      output_cost: 0,
      total_cost: 0,
      prompt_id: "",
      prompt_version: "",
      input: "",
      output: "",
      metadata: "{}",
      latency_ms: 0,
      event_ts: "2026-07-15T00:00:00.000Z",
    } satisfies ObservationRow;
    const [rec] = toStreamLoadRecords("observations", [obs]);
    expect(rec!.end_time).toBeNull();
    expect(rec!.start_time).toBe("2026-07-15 00:00:00.000");

    const emb: EmbeddingRow = {
      project_id: "p",
      observation_id: "o1",
      trace_id: "t1",
      kind: "OBSERVATION",
      model: "m",
      dim: 3,
      vector: [0.1, 0.2, 0.3],
      event_ts: "2026-07-15T00:00:00.000Z",
    };
    const [erec] = toStreamLoadRecords("embeddings", [emb]);
    expect(erec!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(erec!.dim).toBe(3);
  });

  it("streamLoadEnabled reflects the env flag", () => {
    const prev = process.env.TELEMETRY_STREAM_LOAD;
    process.env.TELEMETRY_STREAM_LOAD = "true";
    expect(streamLoadEnabled()).toBe(true);
    process.env.TELEMETRY_STREAM_LOAD = "";
    expect(streamLoadEnabled()).toBe(false);
    if (prev === undefined) delete process.env.TELEMETRY_STREAM_LOAD;
    else process.env.TELEMETRY_STREAM_LOAD = prev;
  });
});
