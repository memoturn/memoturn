import { describe, expect, it } from "vitest";
import { deterministicId, newId } from "./ids.js";

describe("deterministicId", () => {
  it("is stable across calls for the same inputs (the retry-idempotency guarantee)", () => {
    expect(deterministicId("trace-1", "toxicity")).toBe(deterministicId("trace-1", "toxicity"));
  });

  it("differs when any input changes", () => {
    const base = deterministicId("trace-1", "toxicity");
    expect(deterministicId("trace-2", "toxicity")).not.toBe(base);
    expect(deterministicId("trace-1", "helpfulness")).not.toBe(base);
  });

  it("is unambiguous across the part boundary (no space-join collision)", () => {
    // "a b" + "c" must not collide with "a" + "b c".
    expect(deterministicId("a b", "c")).not.toBe(deterministicId("a", "b c"));
  });

  it("produces a UUID-shaped string", () => {
    expect(deterministicId("x", "y")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("is distinct from a random newId", () => {
    expect(deterministicId("x", "y")).not.toBe(newId());
  });
});
