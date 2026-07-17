import { describe, expect, it } from "vitest";
import { buildContextBlock, parseToolCalls } from "./assistant.js";

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

describe("buildContextBlock", () => {
  it("includes org, project, page, and time range when provided", () => {
    const block = buildContextBlock({
      organization: "Acme Inc",
      project: "Default Project",
      page: "/traces/tr_abc123",
      rangeDays: 7,
    });
    expect(block).toContain('"Acme Inc"');
    expect(block).toContain('"Default Project"');
    expect(block).toContain("/traces/tr_abc123");
    expect(block).toContain("last 7 day(s)");
  });

  it("always stamps the current time, even with no context", () => {
    expect(buildContextBlock()).toMatch(/Current UTC time: \d{4}-\d{2}-\d{2}T/);
    expect(buildContextBlock()).not.toContain("Project:");
  });
});
