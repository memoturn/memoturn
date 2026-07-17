import { describe, expect, it } from "vitest";
import { parseToolCalls } from "./assistant.js";

describe("parseToolCalls", () => {
  it("parses a gateway tool-call array", () => {
    const calls = parseToolCalls(JSON.stringify([{ tool: "query_traces", arguments: { level: "ERROR" } }]));
    expect(calls).toEqual([{ tool: "query_traces", arguments: { level: "ERROR" } }]);
  });

  it("parses multiple tool calls", () => {
    const calls = parseToolCalls(JSON.stringify([{ tool: "get_metrics", arguments: {} }, { tool: "query_traces" }]));
    expect(calls).toHaveLength(2);
  });

  it("returns null for a plain-text final answer", () => {
    expect(parseToolCalls("The slowest trace is abc123 at 4.2s.")).toBeNull();
  });

  it("returns null for JSON that isn't a tool-call array", () => {
    expect(parseToolCalls(JSON.stringify({ answer: "hi" }))).toBeNull();
    expect(parseToolCalls(JSON.stringify([{ notATool: 1 }]))).toBeNull();
    expect(parseToolCalls(JSON.stringify([]))).toBeNull();
  });
});
