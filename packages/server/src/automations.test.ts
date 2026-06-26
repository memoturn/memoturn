import { describe, expect, it } from "vitest";
import { automationMatches } from "./automations.js";

describe("automationMatches", () => {
  it("with no threshold or filter, always matches", () => {
    expect(automationMatches({}, { name: "x", value: 5 })).toBe(true);
  });
  it("threshold fires only when the value is below it", () => {
    expect(automationMatches({ threshold: 0.5 }, { value: 0.2 })).toBe(true);
    expect(automationMatches({ threshold: 0.5 }, { value: 0.9 })).toBe(false);
    expect(automationMatches({ threshold: 0.5 }, { value: null })).toBe(false); // no value → not below
  });
  it("filter is a substring match on the name", () => {
    expect(automationMatches({ filter: "rag" }, { name: "rag-pipeline" })).toBe(true);
    expect(automationMatches({ filter: "rag" }, { name: "chat" })).toBe(false);
    expect(automationMatches({ filter: "rag" }, {})).toBe(false);
  });
  it("threshold and filter must both pass", () => {
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "quality" })).toBe(true);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "latency" })).toBe(false);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.9, name: "quality" })).toBe(false);
  });
});
