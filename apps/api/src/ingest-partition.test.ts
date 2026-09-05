import { describe, expect, it } from "vitest";
import { jsonDepth, MAX_EVENT_BYTES, MAX_JSON_DEPTH, partitionIngestBatch } from "./ingest-partition.js";

const TS = "2026-01-01T00:00:00.000Z";

describe("partitionIngestBatch", () => {
  it("persists the ORIGINAL body (no zod defaults) while the parsed form gets them", () => {
    const raw = { id: "e1", timestamp: TS, type: "trace-create", body: { id: "t1", name: "Chat" } };
    const { valid, persist, errors } = partitionIngestBatch([raw]);
    expect(errors).toEqual([]);
    // parsed event has the zod default filled in…
    expect((valid[0]!.body as { environment?: string }).environment).toBe("default");
    // …but the persisted (blob) body does NOT — so the worker can tell it was not client-provided.
    expect(persist[0]).toBe(raw);
    expect(Object.hasOwn((raw as { body: object }).body, "environment")).toBe(false);
  });

  it("keeps a client-provided environment in both", () => {
    const raw = { id: "e1", timestamp: TS, type: "trace-create", body: { id: "t1", environment: "prod" } };
    const { valid, persist } = partitionIngestBatch([raw]);
    expect((valid[0]!.body as { environment?: string }).environment).toBe("prod");
    expect((persist[0] as { body: { environment?: string } }).body.environment).toBe("prod");
  });

  it("reports invalid events with per-event errors and excludes them from persist", () => {
    const good = { id: "e1", timestamp: TS, type: "trace-create", body: { id: "t1" } };
    const bad = { type: "nope" };
    const { valid, persist, errors } = partitionIngestBatch([good, bad, 42]);
    expect(valid).toHaveLength(1);
    expect(persist).toEqual([good]);
    expect(errors.map((e) => e.index)).toEqual([1, 2]);
  });

  it("rejects an event over the per-event byte cap without parsing it, keeping the rest", () => {
    const ok = { id: "ok", type: "trace-create", timestamp: new Date().toISOString(), body: { id: "t" } };
    const huge = { ...ok, id: "huge", body: { id: "t2", input: "x".repeat(MAX_EVENT_BYTES + 1) } };
    const { valid, persist, errors } = partitionIngestBatch([huge, ok]);
    expect(valid.map((e) => e.id)).toEqual(["ok"]);
    expect(persist).toHaveLength(1);
    expect(errors).toEqual([{ id: "huge", index: 0, status: 400, error: expect.stringContaining("per-event limit") }]);
  });

  it("rejects an event nested deeper than the JSON depth cap", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) deep = { deep };
    const ev = {
      id: "deep",
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: "t", metadata: deep },
    };
    const { valid, errors } = partitionIngestBatch([ev]);
    expect(valid).toHaveLength(0);
    expect(errors[0]?.error).toContain("nested deeper");
    // jsonDepth itself: scalars are 0, an object is 1, arrays count.
    expect(jsonDepth("x")).toBe(0);
    expect(jsonDepth({ a: [{ b: 1 }] })).toBe(3);
  });
});
