import { describe, expect, it } from "vitest";
import { decodeOtlpLogs, decodeOtlpTraces, otlpLogsToEvents, otlpToEvents } from "./otel.js";

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

  it("maps Claude Code beta spans: bare input/output/cache tokens + tool naming", () => {
    const cc = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "aaaaaaaaaaaaaaaa",
                  name: "claude_code.llm_request",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  status: { code: 1 },
                  attributes: [
                    { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                    { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4-5" } },
                    { key: "input_tokens", value: { intValue: "1200" } },
                    { key: "output_tokens", value: { intValue: "340" } },
                    { key: "cache_read_tokens", value: { intValue: "800" } },
                    { key: "cache_creation_tokens", value: { intValue: "50" } },
                    { key: "session.id", value: { stringValue: "cc-sess-1" } },
                    { key: "user.id", value: { stringValue: "cc-user" } },
                  ],
                },
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "bbbbbbbbbbbbbbbb",
                  name: "claude_code.tool",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000200000000",
                  status: { code: 1 },
                  attributes: [
                    { key: "gen_ai.tool.call.id", value: { stringValue: "call-1" } },
                    { key: "tool_name", value: { stringValue: "Edit" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const events = otlpToEvents(cc);
    const trace = events.find((e) => e.type === "trace-create")?.body as Record<string, unknown>;
    const gen = events.find((e) => e.type === "generation-create")?.body as Record<string, unknown>;
    const tool = events.find((e) => e.type === "span-create")?.body as Record<string, unknown>;

    expect(gen.model).toBe("claude-sonnet-4-5");
    expect(gen.provider).toBe("anthropic");
    const usage = gen.usage as Record<string, number>;
    expect(usage.promptTokens).toBe(1200); // bare input_tokens
    expect(usage.completionTokens).toBe(340); // bare output_tokens
    expect(usage.totalTokens).toBe(1540);
    expect(usage.cacheReadTokens).toBe(800);
    expect(usage.cacheCreationTokens).toBe(50);
    expect(trace.sessionId).toBe("cc-sess-1"); // session.id → session grouping
    expect(trace.userId).toBe("cc-user");
    expect(tool.name).toBe("tool:Edit"); // claude_code.tool renamed after the actual tool
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

// ── OTLP logs → events ───────────────────────────────────────────────────────────

// Claude Code-shaped OTLP/JSON logs export: no trace context on records, session.id on
// every record, prompt/response text on the two events that carry it.
const jsonLogsPayload = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "deployment.environment.name", value: { stringValue: "staging" } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: "1700000000000000000",
              severityNumber: 9,
              attributes: [
                { key: "event.name", value: { stringValue: "user_prompt" } },
                { key: "session.id", value: { stringValue: "sess-1" } },
                { key: "user.id", value: { stringValue: "user-7" } },
                { key: "prompt", value: { stringValue: "fix the bug" } },
              ],
            },
            {
              timeUnixNano: "1700000001000000000",
              severityNumber: 9,
              body: { stringValue: "I fixed the bug by …" },
              attributes: [
                { key: "event.name", value: { stringValue: "claude_code.assistant_response" } },
                { key: "session.id", value: { stringValue: "sess-1" } },
              ],
            },
            {
              timeUnixNano: "1700000002000000000",
              severityNumber: 9,
              attributes: [
                { key: "event.name", value: { stringValue: "api_error" } },
                { key: "session.id", value: { stringValue: "sess-1" } },
                { key: "error", value: { stringValue: "overloaded_error" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const logBody = (e: { body: unknown }) => e.body as Record<string, unknown>;

describe("otlpLogsToEvents (JSON)", () => {
  it("groups session-scoped records into one synthetic trace with session/user identity", () => {
    const events = otlpLogsToEvents(jsonLogsPayload);
    const traces = events.filter((e) => e.type === "trace-create");
    expect(traces).toHaveLength(1);
    const trace = logBody(traces[0] as { body: unknown });
    expect(trace.id).toBe("otel-logs:sess-1");
    expect(trace.name).toBe("claude-code logs");
    expect(trace.sessionId).toBe("sess-1");
    expect(trace.userId).toBe("user-7");
    expect(trace.environment).toBe("staging");
    for (const ev of events.filter((e) => e.type === "event-create")) {
      expect(logBody(ev).traceId).toBe("otel-logs:sess-1");
    }
  });

  it("maps prompt text to input and response text to output", () => {
    const events = otlpLogsToEvents(jsonLogsPayload).filter((e) => e.type === "event-create");
    const prompt = events.map(logBody).find((b) => b.name === "user_prompt");
    expect(prompt?.input).toBe("fix the bug");
    expect(prompt?.output).toBeUndefined();
    const response = events.map(logBody).find((b) => b.name === "claude_code.assistant_response");
    expect(response?.output).toBe("I fixed the bug by …");
  });

  it("maps api_error to an ERROR event with the error as statusMessage", () => {
    const events = otlpLogsToEvents(jsonLogsPayload).filter((e) => e.type === "event-create");
    const err = events.map(logBody).find((b) => b.name === "api_error");
    expect(err?.level).toBe("ERROR");
    expect(err?.statusMessage).toBe("overloaded_error");
  });

  it("attaches records carrying trace context to the real trace without a trace-create", () => {
    const events = otlpLogsToEvents({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  body: { stringValue: "hello" },
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events.filter((e) => e.type === "trace-create")).toHaveLength(0);
    const ev = logBody(events[0] as { body: unknown });
    expect(ev.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(ev.parentObservationId).toBe("b7ad6b7169203331");
    expect(ev.output).toBe("hello");
  });

  it("treats an all-zero trace id as unset and falls back to a per-export trace", () => {
    const events = otlpLogsToEvents({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  severityNumber: 17,
                  traceId: "0".repeat(32),
                  severityText: "ERROR",
                },
              ],
            },
          ],
        },
      ],
    });
    const traces = events.filter((e) => e.type === "trace-create");
    expect(traces).toHaveLength(1);
    const ev = events.filter((e) => e.type === "event-create").map(logBody)[0];
    expect(ev?.traceId).toBe(logBody(traces[0] as { body: unknown }).id);
    expect(ev?.level).toBe("ERROR");
    expect(ev?.name).toBe("error"); // severityText fallback, lowercased
  });
});

// Inverse of decodeOtlpLogs for round-trip testing, reusing the shared field helpers.
function encodeProtobufLogs(): Uint8Array {
  const record = [
    ...fixed64(1, 1700000001000000000n), // time_unix_nano
    ...[...tag(2, 0), ...varint(9)], // severity_number = INFO
    ...strField(3, "INFO"),
    ...lenDelim(5, anyStr("I fixed the bug by …")), // body AnyValue
    ...lenDelim(6, kv("session.id", anyStr("sess-1"))),
    ...lenDelim(6, kv("event.name", anyStr("assistant_response"))),
  ];
  const scopeLogs = lenDelim(2, lenDelim(2, record)); // ResourceLogs.scope_logs → ScopeLogs.log_records
  const resource = lenDelim(1, lenDelim(1, kv("service.name", anyStr("claude-code"))));
  return new Uint8Array(lenDelim(1, [...resource, ...scopeLogs]));
}

describe("decodeOtlpLogs (protobuf)", () => {
  it("round-trips an ExportLogsServiceRequest into the same mapped events as JSON", () => {
    const events = otlpLogsToEvents(decodeOtlpLogs(encodeProtobufLogs()));
    const trace = events.filter((e) => e.type === "trace-create").map(logBody)[0];
    expect(trace?.id).toBe("otel-logs:sess-1");
    expect(trace?.name).toBe("claude-code logs");
    const ev = events.filter((e) => e.type === "event-create").map(logBody)[0];
    expect(ev?.name).toBe("assistant_response");
    expect(ev?.output).toBe("I fixed the bug by …");
    expect(ev?.startTime).toBe("2023-11-14T22:13:21.000Z");
    expect((ev?.metadata as Record<string, unknown>)["log.severity"]).toBe("INFO");
  });
});

describe("otlpToEvents — the trace is named from its root span", () => {
  // The shape a real FastAPI/OTel export has: the ASGI child events end first, so they are
  // emitted ahead of the request span they belong to. Only the root carries session/user.
  const childFirst = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "felix" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "aa000000000000000000000000000001",
                spanId: "c000000000000001",
                parentSpanId: "a000000000000001",
                name: "POST /chat http receive",
                startTimeUnixNano: "1700000000500000000",
                endTimeUnixNano: "1700000000600000000",
                attributes: [{ key: "asgi.event.type", value: { stringValue: "http.request" } }],
              },
              {
                traceId: "aa000000000000000000000000000001",
                spanId: "c000000000000002",
                parentSpanId: "a000000000000001",
                name: "chat claude-sonnet-4-5",
                startTimeUnixNano: "1700000000600000000",
                endTimeUnixNano: "1700000002000000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4-5" } },
                ],
              },
              {
                // The root: no parent, ends last, so an exporter emits it last.
                traceId: "aa000000000000000000000000000001",
                spanId: "a000000000000001",
                name: "POST /chat",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000004000000000",
                attributes: [
                  { key: "session.id", value: { stringValue: "thread-7" } },
                  { key: "user.id", value: { stringValue: "user-42" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("names the trace after the root, not whichever span arrived first", () => {
    const events = otlpToEvents(childFirst as never);
    const traces = events.filter((e) => e.type === "trace-create");
    expect(traces.length).toBeGreaterThan(0);
    // The last write wins in the field-by-field state merge.
    const final = traces[traces.length - 1]?.body as Record<string, unknown>;
    expect(final.name).toBe("POST /chat");
  });

  it("takes session and user from the root, which is where an exporter puts them", () => {
    const events = otlpToEvents(childFirst as never);
    const traces = events.filter((e) => e.type === "trace-create");
    const final = traces[traces.length - 1]?.body as Record<string, unknown>;
    expect(final.sessionId).toBe("thread-7");
    expect(final.userId).toBe("user-42");
  });

  it("still emits exactly one trace id, however many spans define it", () => {
    const events = otlpToEvents(childFirst as never);
    const ids = new Set(events.filter((e) => e.type === "trace-create").map((e) => (e.body as { id: string }).id));
    expect([...ids]).toEqual(["aa000000000000000000000000000001"]);
  });

  it("falls back to the earliest span when the root is in another batch", () => {
    // Trace split across OTLP requests: every span here has a parent we cannot see.
    const orphaned = structuredClone(childFirst);
    orphaned.resourceSpans[0]!.scopeSpans[0]!.spans = orphaned.resourceSpans[0]!.scopeSpans[0]!.spans.filter(
      (s) => s.spanId !== "a000000000000001",
    );
    const events = otlpToEvents(orphaned as never);
    const traces = events.filter((e) => e.type === "trace-create");
    const final = traces[traces.length - 1]?.body as Record<string, unknown>;
    // Earliest of the remaining spans, not simply the first in the array.
    expect(final.name).toBe("POST /chat http receive");
  });
});
