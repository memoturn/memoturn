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
});
