import type { TraceBody } from "@memoturn/core";
import { describe, expect, it } from "vitest";
import { extractTracePatch } from "./mutablestate.js";

const masked = (over: Record<string, unknown>): TraceBody =>
  ({ id: "t1", environment: "default", ...over }) as unknown as TraceBody;

describe("extractTracePatch", () => {
  it("includes only fields present in the raw wire body, plus id", () => {
    const p = extractTracePatch({ id: "t1", name: "Chat" }, masked({ name: "Chat" }));
    expect(p).toEqual({ id: "t1", name: "Chat" });
  });

  it("ignores the zod-filled environment default when the client did not send it", () => {
    // maskedBody carries environment:"default" (zod default), but the raw body omitted it —
    // so the patch must NOT set environment, or every update would clobber it.
    const p = extractTracePatch({ id: "t1", output: "done" }, masked({ output: "done" }));
    expect(p.environment).toBeUndefined();
    expect(p.output).toBe("done");
  });

  it("includes environment when the client did send it", () => {
    const p = extractTracePatch({ id: "t1", environment: "prod" }, masked({ environment: "prod" }));
    expect(p.environment).toBe("prod");
  });

  it("serializes object metadata/input to JSON strings and passes strings through", () => {
    const p = extractTracePatch(
      { id: "t1", metadata: { a: 1 }, input: "hi" },
      masked({ metadata: { a: 1 }, input: "hi" }),
    );
    expect(p.metadata).toBe('{"a":1}');
    expect(p.input).toBe("hi");
  });

  it("captures tags, public, and timestamp", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const p = extractTracePatch(
      { id: "t1", tags: ["a"], public: true, timestamp: ts },
      masked({ tags: ["a"], public: true, timestamp: ts }),
    );
    expect(p.tags).toEqual(["a"]);
    expect(p.public).toBe(true);
    expect(p.timestamp).toEqual(new Date(ts));
  });
});
