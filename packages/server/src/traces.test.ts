import { beforeEach, describe, expect, it, vi } from "vitest";

const listTraces = vi.fn();
const getTraceIO = vi.fn();
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => ({ listTraces, getTraceIO }) }));

const { getSessionMessages } = await import("./traces.js");

describe("getSessionMessages", () => {
  beforeEach(() => {
    listTraces.mockReset();
    getTraceIO.mockReset();
  });

  it("reconstructs a session's traces as oldest-first turns with their I/O", async () => {
    // Store returns newest-first; the function must order oldest-first.
    listTraces.mockResolvedValue([
      { id: "t2", name: "turn-2", timestamp: "2026-07-24T10:05:00Z", total_tokens: 20, total_cost: 0.02 },
      { id: "t1", name: "turn-1", timestamp: "2026-07-24T10:00:00Z", total_tokens: 10, total_cost: 0.01 },
    ]);
    getTraceIO.mockResolvedValue([
      { id: "t1", name: "turn-1", input: "hi", output: "hello" },
      { id: "t2", name: "turn-2", input: "again?", output: "yes" },
    ]);

    const res = await getSessionMessages("p1", "s1");

    expect(listTraces).toHaveBeenCalledWith("p1", { sessionId: "s1", limit: 500 });
    expect(res.session_id).toBe("s1");
    expect(res.messages.map((m) => m.traceId)).toEqual(["t1", "t2"]); // oldest-first
    expect(res.messages[0]).toEqual({
      traceId: "t1",
      name: "turn-1",
      timestamp: "2026-07-24T10:00:00Z",
      input: "hi",
      output: "hello",
      total_tokens: 10,
      total_cost: 0.01,
    });
  });

  it("returns empty I/O for a trace the I/O fetch didn't cover, and empty messages for an empty session", async () => {
    listTraces.mockResolvedValueOnce([
      { id: "t1", name: "t", timestamp: "2026-07-24T10:00:00Z", total_tokens: 0, total_cost: 0 },
    ]);
    getTraceIO.mockResolvedValueOnce([]); // no I/O rows returned
    const partial = await getSessionMessages("p1", "s1");
    expect(partial.messages[0]).toMatchObject({ input: "", output: "" });

    listTraces.mockResolvedValueOnce([]);
    getTraceIO.mockResolvedValueOnce([]);
    const empty = await getSessionMessages("p1", "none");
    expect(empty.messages).toEqual([]);
  });
});
