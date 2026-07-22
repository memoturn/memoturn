import type { GenerationBody, ScoreBody, TraceBody } from "@memoturn/core";
import { describe, expect, it } from "vitest";
import { extractObservationPatch, extractScorePatch, extractTracePatch } from "./mutablestate.js";

const TS = "2026-01-01T00:00:00.000Z";
const V = BigInt(Date.parse(TS));
const maskedTrace = (over: Record<string, unknown>): TraceBody =>
  ({ id: "t1", environment: "default", ...over }) as unknown as TraceBody;
const maskedObs = (over: Record<string, unknown>): GenerationBody =>
  ({ id: "o1", traceId: "t1", environment: "default", ...over }) as unknown as GenerationBody;
const maskedScore = (over: Record<string, unknown>): ScoreBody =>
  ({
    id: "s1",
    traceId: "t1",
    name: "quality",
    environment: "default",
    source: "API",
    dataType: "NUMERIC",
    ...over,
  }) as unknown as ScoreBody;

describe("extractTracePatch", () => {
  it("includes only fields present in the raw wire body", () => {
    const p = extractTracePatch({ id: "t1", name: "Chat" }, maskedTrace({ name: "Chat" }), TS);
    expect(p).toEqual({ id: "t1", mergeVersion: V, scalars: { name: "Chat" } });
  });

  it("ignores the zod-filled environment default when the client did not send it", () => {
    const p = extractTracePatch({ id: "t1", output: "done" }, maskedTrace({ output: "done" }), TS);
    expect(p.scalars.environment).toBeUndefined();
    expect(p.scalars.output).toBe("done");
  });

  it("includes environment when the client did send it", () => {
    const p = extractTracePatch({ id: "t1", environment: "prod" }, maskedTrace({ environment: "prod" }), TS);
    expect(p.scalars.environment).toBe("prod");
  });

  it("serializes object metadata, passes strings through, and carries tags separately", () => {
    const p = extractTracePatch(
      { id: "t1", metadata: { a: 1 }, input: "hi", tags: ["x"] },
      maskedTrace({ metadata: { a: 1 }, input: "hi", tags: ["x"] }),
      TS,
    );
    expect(p.scalars.metadata).toBe('{"a":1}');
    expect(p.scalars.input).toBe("hi");
    expect(p.tags).toEqual(["x"]);
  });

  it("omits tags entirely when not provided (so the merge keeps stored tags)", () => {
    const p = extractTracePatch({ id: "t1", name: "x" }, maskedTrace({ name: "x" }), TS);
    expect(p.tags).toBeUndefined();
  });
});

describe("extractObservationPatch", () => {
  it("derives type from the event kind and always sets traceId", () => {
    const p = extractObservationPatch({ id: "o1", traceId: "t1" }, maskedObs({}), "generation-create", TS);
    expect(p.scalars.type).toBe("GENERATION");
    expect(p.scalars.traceId).toBe("t1");
    expect(p.mergeVersion).toBe(V);
  });

  it("honors an observationType override", () => {
    const p = extractObservationPatch(
      { id: "o1", traceId: "t1", observationType: "TOOL" },
      maskedObs({ observationType: "TOOL" }),
      "span-create",
      TS,
    );
    expect(p.scalars.type).toBe("TOOL");
  });

  it("extracts nested usage tokens only for keys the client sent", () => {
    const p = extractObservationPatch(
      { id: "o1", traceId: "t1", usage: { promptTokens: 10, completionTokens: 5 } },
      maskedObs({ usage: { promptTokens: 10, completionTokens: 5 } }),
      "generation-update",
      TS,
    );
    expect(p.scalars.promptTokens).toBe(10);
    expect(p.scalars.completionTokens).toBe(5);
    expect(p.scalars.totalTokens).toBeUndefined(); // not sent → not set
  });

  it("does not set token/model fields absent from an update (so the merge keeps them)", () => {
    const p = extractObservationPatch(
      { id: "o1", traceId: "t1", endTime: "2026-01-01T00:01:00.000Z" },
      maskedObs({ endTime: "2026-01-01T00:01:00.000Z" }),
      "generation-update",
      TS,
    );
    expect(p.scalars.endTime).toBeInstanceOf(Date);
    expect(p.scalars.model).toBeUndefined();
    expect(p.scalars.promptTokens).toBeUndefined();
  });

  it("does NOT set type on an update that omits observationType (keeps a prior TOOL/AGENT override)", () => {
    // Common span lifecycle: created as TOOL, later updated with just endTime/output. The update
    // must not re-derive type from the kind (GENERATION) and clobber the stored TOOL.
    const p = extractObservationPatch(
      { id: "o1", traceId: "t1", endTime: "2026-01-01T00:01:00.000Z" },
      maskedObs({ endTime: "2026-01-01T00:01:00.000Z" }),
      "generation-update",
      TS,
    );
    expect(p.scalars.type).toBeUndefined();
  });

  it("sets type on an update that DOES carry an observationType override", () => {
    const p = extractObservationPatch(
      { id: "o1", traceId: "t1", observationType: "AGENT" },
      maskedObs({ observationType: "AGENT" }),
      "span-update",
      TS,
    );
    expect(p.scalars.type).toBe("AGENT");
  });
});

describe("extractScorePatch", () => {
  it("always sets the required traceId + name and the merge version", () => {
    const p = extractScorePatch(
      { id: "s1", traceId: "t1", name: "quality", value: 0.9 },
      maskedScore({ value: 0.9 }),
      TS,
    );
    expect(p.scalars.traceId).toBe("t1");
    expect(p.scalars.name).toBe("quality");
    expect(p.scalars.value).toBe(0.9);
    expect(p.mergeVersion).toBe(V);
  });

  it("only sets source/dataType when the client sent them (NULL coalesces to defaults at mirror)", () => {
    const p = extractScorePatch({ id: "s1", traceId: "t1", name: "quality", value: 1 }, maskedScore({ value: 1 }), TS);
    expect(p.scalars.source).toBeUndefined();
    expect(p.scalars.dataType).toBeUndefined();
    const p2 = extractScorePatch(
      { id: "s1", traceId: "t1", name: "quality", source: "EVAL", dataType: "CATEGORICAL", stringValue: "good" },
      maskedScore({ source: "EVAL", dataType: "CATEGORICAL", stringValue: "good" }),
      TS,
    );
    expect(p2.scalars.source).toBe("EVAL");
    expect(p2.scalars.stringValue).toBe("good");
  });
});
