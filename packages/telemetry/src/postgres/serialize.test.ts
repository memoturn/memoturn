import { describe, expect, it } from "vitest";
import type { ScoreWriteRow, TraceRow } from "../types.js";
import { SqlArray } from "./client.js";
import { buildUpserts, dedupeByPk } from "./serialize.js";

const trace = (id: string, eventTs: string, overrides: Partial<TraceRow> = {}): TraceRow => ({
  id,
  project_id: "p1",
  timestamp: "2026-07-01T10:00:00.000Z",
  name: "t",
  user_id: "",
  session_id: "",
  release: "",
  version: "",
  environment: "default",
  public: 0,
  tags: [],
  metadata: "{}",
  input: "",
  output: "",
  event_ts: eventTs,
  ...overrides,
});

describe("dedupeByPk", () => {
  it("keeps the max-event_ts row per primary key", () => {
    const rows = [
      trace("a", "2026-07-01T10:00:02.000Z", { name: "newer" }),
      trace("a", "2026-07-01T10:00:01.000Z", { name: "older" }),
      trace("b", "2026-07-01T10:00:00.000Z"),
    ];
    const deduped = dedupeByPk("traces", rows);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((r) => r.id === "a")?.name).toBe("newer");
  });

  it("on equal event_ts the later array position wins (load order)", () => {
    const ts = "2026-07-01T10:00:00.000Z";
    const deduped = dedupeByPk("traces", [trace("a", ts, { name: "first" }), trace("a", ts, { name: "second" })]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.name).toBe("second");
  });
});

describe("buildUpserts", () => {
  it("emits ON CONFLICT with the LWW >= guard and excludes PK columns from the update set", () => {
    const [stmt] = buildUpserts("traces", [trace("a", "2026-07-01T10:00:00.000Z")]);
    expect(stmt?.sql).toContain("ON CONFLICT (project_id, id) DO UPDATE SET");
    expect(stmt?.sql).toContain("WHERE excluded.event_ts >= t.event_ts");
    expect(stmt?.sql).not.toMatch(/SET[^)]*\bproject_id = excluded/);
    // Doris-reserved identifiers are double-quoted.
    expect(stmt?.sql).toContain('"timestamp" = excluded."timestamp"');
  });

  it("binds tags as a SqlArray column value and timestamps as engine literals", () => {
    const [stmt] = buildUpserts("traces", [trace("a", "2026-07-01T10:00:00.123Z", { tags: ['say "hi"', "b,c"] })]);
    const tagsParam = stmt?.params.find((p) => p instanceof SqlArray) as SqlArray | undefined;
    expect(tagsParam?.values).toEqual(['say "hi"', "b,c"]);
    expect(stmt?.params).toContain("2026-07-01 10:00:00.123");
  });

  it("casts the embeddings vector param and serializes it as a pgvector literal", () => {
    const [stmt] = buildUpserts("embeddings", [
      {
        project_id: "p1",
        observation_id: "o1",
        trace_id: "t1",
        kind: "OBSERVATION",
        model: "m",
        dim: 3,
        vector: [0.1, 0.2, 0.3],
        event_ts: "2026-07-01T10:00:00.000Z",
      },
    ]);
    expect(stmt?.sql).toContain("?::vector");
    expect(stmt?.params).toContain("[0.1,0.2,0.3]");
  });

  it("dedupes duplicate keys within one batch (PG cannot upsert the same key twice per statement)", () => {
    const [stmt, ...rest] = buildUpserts("traces", [
      trace("a", "2026-07-01T10:00:01.000Z", { name: "older" }),
      trace("a", "2026-07-01T10:00:02.000Z", { name: "newer" }),
    ]);
    expect(rest).toHaveLength(0);
    expect(stmt?.params.filter((p) => p === "a")).toHaveLength(1);
    expect(stmt?.params).toContain("newer");
    expect(stmt?.params).not.toContain("older");
  });

  it("chunks by the parameter cap", () => {
    const rows: ScoreWriteRow[] = Array.from({ length: 4300 }, (_, i) => ({
      id: `s${i}`,
      project_id: "p1",
      trace_id: "t1",
      observation_id: "",
      name: "quality",
      timestamp: "2026-07-01T10:00:00.000Z",
      environment: "default",
      source: "API",
      data_type: "NUMERIC",
      value: 1,
      string_value: "",
      comment: "",
      config_id: "",
      event_ts: "2026-07-01T10:00:00.000Z",
    }));
    const stmts = buildUpserts("scores", rows);
    // 14 params/row → 4,285 rows per statement cap.
    expect(stmts.length).toBe(2);
    const totalParams = stmts.reduce((s, st) => s + st.params.length, 0);
    expect(totalParams).toBe(4300 * 14);
    for (const st of stmts) expect(st.params.length).toBeLessThanOrEqual(60_000);
  });
});
