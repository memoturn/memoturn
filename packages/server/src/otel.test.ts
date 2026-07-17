import { describe, expect, it } from "vitest";
import { decodeOtlpTraces, otlpToEvents } from "./otel.js";

// A JSON OTLP payload with resource attrs + a GenAI span (mirrors what an OTLP/JSON
// exporter sends). The same logical payload is encoded to protobuf below.
const jsonPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "agent" } },
          { key: "deployment.environment.name", value: { stringValue: "staging" } },
          { key: "service.version", value: { stringValue: "2.0.0" } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              parentSpanId: "0020000000000001",
              name: "chat",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              status: { code: 1 },
              attributes: [
                { key: "gen_ai.system", value: { stringValue: "openai" } },
                { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                { key: "gen_ai.request.temperature", value: { doubleValue: 0.5 } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "8" } },
                { key: "gen_ai.conversation.id", value: { stringValue: "conv-9" } },
                { key: "gen_ai.user.id", value: { stringValue: "user-3" } },
                { key: "gen_ai.prompt", value: { stringValue: "ping" } },
                { key: "gen_ai.completion", value: { stringValue: "pong" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function assertMapped(events: ReturnType<typeof otlpToEvents>) {
  const trace = events.find((e) => e.type === "trace-create");
  const gen = events.find((e) => e.type === "generation-create");
  expect(trace, "trace-create emitted").toBeDefined();
  expect(gen, "generation-create emitted").toBeDefined();

  const tb = trace?.body as Record<string, unknown>;
  expect(tb.environment).toBe("staging");
  expect(tb.release).toBe("2.0.0");
  expect(tb.sessionId).toBe("conv-9");
  expect(tb.userId).toBe("user-3");

  const gb = gen?.body as Record<string, unknown>;
  expect(gb.model).toBe("gpt-4o-mini");
  expect(gb.provider).toBe("openai");
  expect(gb.input).toBe("ping");
  expect(gb.output).toBe("pong");
  expect((gb.usage as Record<string, number>).promptTokens).toBe(42);
  expect((gb.usage as Record<string, number>).completionTokens).toBe(8);
  expect((gb.usage as Record<string, number>).totalTokens).toBe(50);
  expect((gb.modelParameters as Record<string, unknown>).temperature).toBe(0.5);
  expect((gb.modelParameters as Record<string, unknown>).maxTokens).toBeUndefined();
  expect(gb.level).toBe("DEFAULT");
}

describe("otlpToEvents (JSON)", () => {
  it("maps GenAI semconv attributes onto trace + generation events", () => {
    assertMapped(otlpToEvents(jsonPayload));
  });

  it("falls back to gen_ai.input/output.messages over prompt/completion", () => {
    const p = structuredClone(jsonPayload);
    const attrs = p.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
    attrs?.push({ key: "gen_ai.input.messages", value: { stringValue: "newer-input" } });
    const gen = otlpToEvents(p).find((e) => e.type === "generation-create");
    expect((gen?.body as Record<string, unknown>).input).toBe("newer-input");
  });

  it("maps an MCP tools/call span to a first-class span named after the tool", () => {
    const mcpPayload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                  name: "tools/call", // generic instrumentation name
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000500000000",
                  status: { code: 2, message: "tool failed" },
                  attributes: [
                    { key: "mcp.method.name", value: { stringValue: "tools/call" } },
                    { key: "mcp.tool.name", value: { stringValue: "search-kb" } },
                    { key: "mcp.session.id", value: { stringValue: "mcp-sess-1" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const events = otlpToEvents(mcpPayload);
    const trace = events.find((e) => e.type === "trace-create")?.body as Record<string, unknown>;
    const span = events.find((e) => e.type === "span-create")?.body as Record<string, unknown>;

    expect(events.find((e) => e.type === "generation-create")).toBeUndefined(); // not a generation
    expect(trace.sessionId).toBe("mcp-sess-1"); // mcp.session.id → session
    expect(span.name).toBe("mcp:search-kb"); // named after the tool, first-class + analytics-visible
    expect(span.level).toBe("ERROR"); // status code 2
    expect((span.metadata as Record<string, unknown>)["mcp.method.name"]).toBe("tools/call");
  });

  it("names non-tool MCP methods after the method", () => {
    const p = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "1af7651916cd43dd8448eb211c80319c",
                  spanId: "c7ad6b7169203331",
                  name: "list",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000100000000",
                  attributes: [{ key: "mcp.method.name", value: { stringValue: "tools/list" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const span = otlpToEvents(p).find((e) => e.type === "span-create")?.body as Record<string, unknown>;
    expect(span.name).toBe("mcp:tools/list");
  });

  // OpenInference (Phoenix + its framework instrumentors) semconv: openinference.span.kind.
  const oiSpan = (attrs: { key: string; value: Record<string, unknown> }[]) => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "2af7651916cd43dd8448eb211c80319c",
                spanId: "d7ad6b7169203331",
                name: "step",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000200000000",
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  });

  it("classifies an OpenInference RETRIEVER span by its span kind", () => {
    const span = otlpToEvents(oiSpan([{ key: "openinference.span.kind", value: { stringValue: "RETRIEVER" } }])).find(
      (e) => e.type === "span-create",
    )?.body as Record<string, unknown>;
    expect(span.observationType).toBe("RETRIEVER");
  });

  it("maps OpenInference retrieval.documents on a RETRIEVER span to ranked retrieved docs", () => {
    const span = otlpToEvents(
      oiSpan([
        { key: "openinference.span.kind", value: { stringValue: "RETRIEVER" } },
        { key: "retrieval.documents.0.document.content", value: { stringValue: "doc A" } },
        { key: "retrieval.documents.0.document.score", value: { doubleValue: 0.91 } },
        { key: "retrieval.documents.0.document.id", value: { stringValue: "a" } },
        { key: "retrieval.documents.1.document.content", value: { stringValue: "doc B" } },
        { key: "retrieval.documents.1.document.score", value: { doubleValue: 0.42 } },
      ]),
    ).find((e) => e.type === "span-create")?.body as Record<string, unknown>;
    const docs = span.retrievedDocuments as { rank: number; content: string; score?: number; id?: string }[];
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ rank: 0, content: "doc A", score: 0.91, id: "a" });
    expect(docs[1]).toMatchObject({ rank: 1, content: "doc B", score: 0.42 });
  });

  it("maps an OpenInference LLM span to a generation, reading llm.* model + tokens + io", () => {
    const events = otlpToEvents(
      oiSpan([
        { key: "openinference.span.kind", value: { stringValue: "LLM" } },
        { key: "llm.model_name", value: { stringValue: "claude-sonnet-4-6" } },
        { key: "llm.provider", value: { stringValue: "anthropic" } },
        { key: "llm.token_count.prompt", value: { intValue: "120" } },
        { key: "llm.token_count.completion", value: { intValue: "30" } },
        { key: "input.value", value: { stringValue: "hi" } },
        { key: "output.value", value: { stringValue: "hello" } },
      ]),
    );
    const gen = events.find((e) => e.type === "generation-create")?.body as Record<string, unknown>;
    expect(gen).toBeDefined();
    expect(gen.model).toBe("claude-sonnet-4-6");
    expect(gen.provider).toBe("anthropic");
    expect(gen.input).toBe("hi");
    expect(gen.output).toBe("hello");
    expect((gen.usage as Record<string, number>).promptTokens).toBe(120);
    expect((gen.usage as Record<string, number>).completionTokens).toBe(30);
  });

  // gen_ai.evaluation.result: OTel GenAI semconv's span-event way of reporting an eval score.
  const spanWithEvents = (
    spanEvents: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[],
  ) => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "3af7651916cd43dd8448eb211c80319c",
                spanId: "e7ad6b7169203331",
                name: "chat",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000200000000",
                attributes: [
                  { key: "gen_ai.system", value: { stringValue: "openai" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                ],
                events: spanEvents,
              },
            ],
          },
        ],
      },
    ],
  });

  it("maps a gen_ai.evaluation.result event with a numeric score to a NUMERIC score-create", () => {
    const events = otlpToEvents(
      spanWithEvents([
        {
          name: "gen_ai.evaluation.result",
          attributes: [
            { key: "gen_ai.evaluation.name", value: { stringValue: "relevance" } },
            { key: "gen_ai.evaluation.score.value", value: { doubleValue: 0.87 } },
            { key: "gen_ai.evaluation.explanation", value: { stringValue: "on topic" } },
          ],
        },
      ]),
    );
    const score = events.find((e) => e.type === "score-create")?.body as Record<string, unknown>;
    expect(score).toBeDefined();
    expect(score.traceId).toBe("3af7651916cd43dd8448eb211c80319c");
    expect(score.observationId).toBe("e7ad6b7169203331");
    expect(score.name).toBe("relevance");
    expect(score.source).toBe("EVAL");
    expect(score.dataType).toBe("NUMERIC");
    expect(score.value).toBe(0.87);
    expect(score.comment).toBe("on topic");
  });

  it("maps a gen_ai.evaluation.result event with a label-only score to a CATEGORICAL score-create", () => {
    const events = otlpToEvents(
      spanWithEvents([
        {
          name: "gen_ai.evaluation.result",
          attributes: [
            { key: "gen_ai.evaluation.name", value: { stringValue: "toxicity" } },
            { key: "gen_ai.evaluation.score.label", value: { stringValue: "not_toxic" } },
          ],
        },
      ]),
    );
    const score = events.find((e) => e.type === "score-create")?.body as Record<string, unknown>;
    expect(score).toBeDefined();
    expect(score.dataType).toBe("CATEGORICAL");
    expect(score.stringValue).toBe("not_toxic");
    expect(score.value).toBeUndefined();
  });

  it("drops a malformed gen_ai.evaluation.result event without failing the rest of the span", () => {
    const events = otlpToEvents(
      spanWithEvents([
        // missing gen_ai.evaluation.name entirely
        {
          name: "gen_ai.evaluation.result",
          attributes: [{ key: "gen_ai.evaluation.score.value", value: { doubleValue: 1 } }],
        },
      ]),
    );
    expect(events.find((e) => e.type === "score-create")).toBeUndefined();
    // the span's own generation event still mapped fine
    expect(events.find((e) => e.type === "generation-create")).toBeDefined();
  });

  it("ignores span events that aren't gen_ai.evaluation.result", () => {
    const events = otlpToEvents(spanWithEvents([{ name: "some.other.event", attributes: [] }]));
    expect(events.find((e) => e.type === "score-create")).toBeUndefined();
  });

  // ── Span-kind mapping: Vercel AI SDK, Genkit, LiveKit Agents, Flue ──────────────
  const spanNamed = (name: string | undefined, attrs: { key: string; value: Record<string, unknown> }[]) => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "5af7651916cd43dd8448eb211c80319c",
                spanId: "16ad6b7169203331",
                name,
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000300000000",
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  });
  const spanBody = (events: ReturnType<typeof otlpToEvents>) =>
    (events.find((e) => e.type === "span-create" || e.type === "generation-create")?.body ?? {}) as Record<
      string,
      unknown
    >;

  it("classifies a Flue execute_tool span as TOOL via gen_ai.operation.name (not GENERATION)", () => {
    // Regression case: this span carries a gen_ai.*-prefixed attribute (gen_ai.tool.name) but
    // is NOT a model call — the naive "any gen_ai.* attr present" check used to misclassify it.
    const events = otlpToEvents(
      spanNamed("execute_tool search", [
        { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
        { key: "gen_ai.tool.name", value: { stringValue: "search" } },
      ]),
    );
    expect(events.find((e) => e.type === "generation-create")).toBeUndefined();
    expect(spanBody(events).observationType).toBe("TOOL");
  });

  it("classifies a Flue invoke_agent span as AGENT via gen_ai.operation.name", () => {
    const events = otlpToEvents(
      spanNamed("invoke_agent researcher", [
        { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
        { key: "gen_ai.agent.name", value: { stringValue: "researcher" } },
      ]),
    );
    expect(spanBody(events).observationType).toBe("AGENT");
  });

  it("classifies a gen_ai.operation.name=chat span as GENERATION (Flue / LiveKit / Vercel AI SDK v7+)", () => {
    const events = otlpToEvents(
      spanNamed("chat gpt-4o-mini", [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }]),
    );
    expect(events.find((e) => e.type === "generation-create")).toBeDefined();
  });

  it("classifies a gen_ai.tool.name span as TOOL without an operation.name (Pydantic AI style)", () => {
    const events = otlpToEvents(spanNamed("tool", [{ key: "gen_ai.tool.name", value: { stringValue: "lookup" } }]));
    expect(spanBody(events).observationType).toBe("TOOL");
  });

  it("classifies legacy Vercel AI SDK doGenerate/doEmbed/toolCall spans (pre-v7 ai.* namespace)", () => {
    const gen = otlpToEvents(
      spanNamed("ai.generateText.doGenerate", [
        { key: "ai.operationId", value: { stringValue: "ai.generateText.doGenerate" } },
        { key: "ai.model.id", value: { stringValue: "gpt-4o" } },
        { key: "ai.model.provider", value: { stringValue: "openai.chat" } },
      ]),
    );
    expect(gen.find((e) => e.type === "generation-create")).toBeDefined();
    expect(spanBody(gen).model).toBe("gpt-4o");
    expect(spanBody(gen).provider).toBe("openai.chat");

    const embed = otlpToEvents(
      spanNamed("ai.embed.doEmbed", [{ key: "ai.operationId", value: { stringValue: "ai.embed.doEmbed" } }]),
    );
    expect(spanBody(embed).observationType).toBe("EMBEDDING");

    const tool = otlpToEvents(
      spanNamed("ai.toolCall", [{ key: "ai.operationId", value: { stringValue: "ai.toolCall" } }]),
    );
    expect(spanBody(tool).observationType).toBe("TOOL");
  });

  it("classifies Genkit spans by genkit:metadata:subtype", () => {
    const cases: [string, string][] = [
      ["model", "GENERATION"],
      ["embedder", "EMBEDDING"],
      ["tool", "TOOL"],
      ["retriever", "RETRIEVER"],
      ["reranker", "RERANKER"],
      ["agent", "AGENT"],
      ["flow", "CHAIN"],
    ];
    for (const [subtype, expected] of cases) {
      const events = otlpToEvents(
        spanNamed("genkit-step", [{ key: "genkit:metadata:subtype", value: { stringValue: subtype } }]),
      );
      if (expected === "GENERATION") {
        expect(
          events.find((e) => e.type === "generation-create"),
          subtype,
        ).toBeDefined();
      } else {
        expect(spanBody(events).observationType, subtype).toBe(expected);
      }
    }
  });

  it("leaves a Genkit evaluator span unmapped (plain SPAN, not GUARDRAIL)", () => {
    const events = otlpToEvents(
      spanNamed("genkit-step", [{ key: "genkit:metadata:subtype", value: { stringValue: "evaluator" } }]),
    );
    expect(spanBody(events).observationType).toBeUndefined();
  });

  it("classifies LiveKit Agents spans by name (llm_request / function_tool)", () => {
    const gen = otlpToEvents(spanNamed("llm_request", []));
    expect(gen.find((e) => e.type === "generation-create")).toBeDefined();

    const tool = otlpToEvents(spanNamed("function_tool", []));
    expect(spanBody(tool).observationType).toBe("TOOL");
  });
});

// ── Minimal protobuf encoder (inverse of decodeOtlpTraces) for round-trip testing ─
function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenDelim = (field: number, bytes: number[]) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const strField = (field: number, s: string) => lenDelim(field, [...new TextEncoder().encode(s)]);
function fixed64(field: number, v: bigint): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, v, true);
  return [...tag(field, 1), ...new Uint8Array(buf)];
}
function doubleVal(field: number, v: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, v, true);
  return [...tag(field, 1), ...new Uint8Array(buf)];
}
const hexBytes = (h: string): number[] => h.match(/.{2}/g)?.map((x) => Number.parseInt(x, 16)) ?? [];
const anyStr = (s: string) => lenDelim(1, [...new TextEncoder().encode(s)]);
const anyInt = (n: number) => [...tag(3, 0), ...varint(n)];
const kv = (key: string, value: number[]) => [...strField(1, key), ...lenDelim(2, value)];

function encodeProtobuf(): Uint8Array {
  const spanAttrs = [
    ["gen_ai.system", anyStr("openai")],
    ["gen_ai.request.model", anyStr("gpt-4o-mini")],
    ["gen_ai.request.temperature", doubleVal(4, 0.5)], // AnyValue.double_value
    ["gen_ai.usage.input_tokens", anyInt(42)],
    ["gen_ai.usage.output_tokens", anyInt(8)],
    ["gen_ai.conversation.id", anyStr("conv-9")],
    ["gen_ai.user.id", anyStr("user-3")],
    ["gen_ai.prompt", anyStr("ping")],
    ["gen_ai.completion", anyStr("pong")],
  ].flatMap(([k, v]) => lenDelim(9, kv(k as string, v as number[])));
  const status = lenDelim(15, [...tag(3, 0), ...varint(1)]);
  const span = [
    ...lenDelim(1, hexBytes("0af7651916cd43dd8448eb211c80319c")),
    ...lenDelim(2, hexBytes("b7ad6b7169203331")),
    ...lenDelim(4, hexBytes("0020000000000001")),
    ...strField(5, "chat"),
    ...fixed64(7, 1700000000000000000n),
    ...fixed64(8, 1700000001000000000n),
    ...spanAttrs,
    ...status,
  ];
  const scopeSpans = lenDelim(2, lenDelim(2, span)); // ResourceSpans.scope_spans → ScopeSpans.spans
  const resource = lenDelim(1, [
    ...lenDelim(1, kv("service.name", anyStr("agent"))),
    ...lenDelim(1, kv("deployment.environment.name", anyStr("staging"))),
    ...lenDelim(1, kv("service.version", anyStr("2.0.0"))),
  ]);
  return new Uint8Array(lenDelim(1, [...resource, ...scopeSpans]));
}

// A span carrying one Span.Event (field 11) named gen_ai.evaluation.result, so the
// hand-rolled protobuf decoder's brand-new span-events path gets a real round-trip test.
function encodeProtobufWithEvalEvent(): Uint8Array {
  const evalEventAttrs = [
    ["gen_ai.evaluation.name", anyStr("relevance")],
    ["gen_ai.evaluation.score.value", doubleVal(4, 0.75)], // AnyValue.double_value
  ].flatMap(([k, v]) => lenDelim(3, kv(k as string, v as number[]))); // Span.Event.attributes → field 3
  const evalEvent = [
    ...fixed64(1, 1700000000500000000n), // Span.Event.time_unix_nano → field 1
    ...strField(2, "gen_ai.evaluation.result"), // Span.Event.name → field 2
    ...evalEventAttrs,
  ];
  const span = [
    ...lenDelim(1, hexBytes("4af7651916cd43dd8448eb211c80319c")),
    ...lenDelim(2, hexBytes("f7ad6b7169203331")),
    ...strField(5, "chat"),
    ...fixed64(7, 1700000000000000000n),
    ...fixed64(8, 1700000000500000000n),
    ...lenDelim(11, evalEvent), // Span.events → field 11
  ];
  const scopeSpans = lenDelim(2, lenDelim(2, span));
  return new Uint8Array(lenDelim(1, scopeSpans));
}

describe("decodeOtlpTraces (protobuf)", () => {
  it("decodes an ExportTraceServiceRequest into the same mapped events as JSON", () => {
    const payload = decodeOtlpTraces(encodeProtobuf());
    assertMapped(otlpToEvents(payload));
  });

  it("hex-encodes span ids and parent links", () => {
    const payload = decodeOtlpTraces(encodeProtobuf());
    const span = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span?.spanId).toBe("b7ad6b7169203331");
    expect(span?.parentSpanId).toBe("0020000000000001");
  });

  it("decodes a Span.Event and maps gen_ai.evaluation.result to a NUMERIC score-create", () => {
    const payload = decodeOtlpTraces(encodeProtobufWithEvalEvent());
    const span = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.events).toHaveLength(1);
    expect(span?.events?.[0]?.name).toBe("gen_ai.evaluation.result");

    const score = otlpToEvents(payload).find((e) => e.type === "score-create")?.body as Record<string, unknown>;
    expect(score).toBeDefined();
    expect(score.traceId).toBe("4af7651916cd43dd8448eb211c80319c");
    expect(score.observationId).toBe("f7ad6b7169203331");
    expect(score.name).toBe("relevance");
    expect(score.dataType).toBe("NUMERIC");
    expect(score.value).toBe(0.75);
    expect(score.source).toBe("EVAL");
  });
});
