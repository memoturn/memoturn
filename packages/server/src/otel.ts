import { type IngestEvent, newId, type ObservationType } from "@memoturn/core";

/**
 * OTLP → memoturn ingest mapping. Accepts OTLP traces as JSON or protobuf (see
 * decodeOtlpTraces) and maps each span to an observation, emitting a trace-create per
 * distinct OTel traceId. Span classification spans two semconventions: OTLP GenAI
 * (`gen_ai.*` → GENERATION) and OpenInference (`openinference.span.kind` → LLM→GENERATION,
 * RETRIEVER/RERANKER/EMBEDDING/CHAIN/TOOL/AGENT/GUARDRAIL → the matching observation type);
 * everything else is a plain SPAN.
 */

interface OtlpAttr {
  key: string;
  value?: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttr[];
  status?: { code?: number; message?: string };
}
interface OtlpResource {
  attributes?: OtlpAttr[];
}
interface OtlpPayload {
  resourceSpans?: { resource?: OtlpResource; scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

// ── OTLP/protobuf decode ─────────────────────────────────────────────────────────
// A minimal, dependency-free decoder for ExportTraceServiceRequest that produces the
// same OtlpPayload shape as the JSON path (ids hex-encoded, times as nano strings,
// attributes in OTLP/JSON value shape) so otlpToEvents can be reused unchanged.
class PbReader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
  tag(): { field: number; wire: number } {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 7 };
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }
  fixed64u(): bigint {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  double(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
  }
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function decodeAnyValue(b: Uint8Array): OtlpAttr["value"] {
  const r = new PbReader(b);
  const out: NonNullable<OtlpAttr["value"]> = {};
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) out.stringValue = r.string();
    else if (field === 2 && wire === 0) out.boolValue = r.varint() !== 0n;
    else if (field === 3 && wire === 0) out.intValue = r.varint().toString();
    else if (field === 4 && wire === 1) out.doubleValue = r.double();
    else r.skip(wire);
  }
  return out;
}

function decodeKeyValue(b: Uint8Array): OtlpAttr {
  const r = new PbReader(b);
  let key = "";
  let value: OtlpAttr["value"];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) key = r.string();
    else if (field === 2 && wire === 2) value = decodeAnyValue(r.bytes());
    else r.skip(wire);
  }
  return { key, value };
}

function decodeSpan(b: Uint8Array): OtlpSpan {
  const r = new PbReader(b);
  const span: OtlpSpan = { traceId: "", spanId: "", attributes: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) span.traceId = hex(r.bytes());
    else if (field === 2 && wire === 2) span.spanId = hex(r.bytes());
    else if (field === 4 && wire === 2) span.parentSpanId = hex(r.bytes());
    else if (field === 5 && wire === 2) span.name = r.string();
    else if (field === 7 && wire === 1) span.startTimeUnixNano = r.fixed64u().toString();
    else if (field === 8 && wire === 1) span.endTimeUnixNano = r.fixed64u().toString();
    else if (field === 9 && wire === 2) span.attributes?.push(decodeKeyValue(r.bytes()));
    else if (field === 15 && wire === 2) span.status = decodeStatus(r.bytes());
    else r.skip(wire);
  }
  return span;
}

function decodeStatus(b: Uint8Array): OtlpSpan["status"] {
  const r = new PbReader(b);
  const status: NonNullable<OtlpSpan["status"]> = {};
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 2 && wire === 2) status.message = r.string();
    else if (field === 3 && wire === 0) status.code = Number(r.varint());
    else r.skip(wire);
  }
  return status;
}

function decodeAttributes(b: Uint8Array): OtlpAttr[] {
  // Resource / InstrumentationScope: field 1 = repeated KeyValue attributes.
  const r = new PbReader(b);
  const attrs: OtlpAttr[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) attrs.push(decodeKeyValue(r.bytes()));
    else r.skip(wire);
  }
  return attrs;
}

function decodeScopeSpans(b: Uint8Array): { spans: OtlpSpan[] } {
  const r = new PbReader(b);
  const spans: OtlpSpan[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 2 && wire === 2) spans.push(decodeSpan(r.bytes()));
    else r.skip(wire);
  }
  return { spans };
}

function decodeResourceSpans(b: Uint8Array): { resource?: OtlpResource; scopeSpans: { spans?: OtlpSpan[] }[] } {
  const r = new PbReader(b);
  let resource: OtlpResource | undefined;
  const scopeSpans: { spans?: OtlpSpan[] }[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) resource = { attributes: decodeAttributes(r.bytes()) };
    else if (field === 2 && wire === 2) scopeSpans.push(decodeScopeSpans(r.bytes()));
    else r.skip(wire);
  }
  return { resource, scopeSpans };
}

/** Decode an OTLP/protobuf ExportTraceServiceRequest into the OtlpPayload shape. */
export function decodeOtlpTraces(bytes: Uint8Array): OtlpPayload {
  const r = new PbReader(bytes);
  const resourceSpans: OtlpPayload["resourceSpans"] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) resourceSpans?.push(decodeResourceSpans(r.bytes()));
    else r.skip(wire);
  }
  return { resourceSpans };
}

function attrValue(a: OtlpAttr): unknown {
  const v = a.value ?? {};
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

function nanoToIso(nano?: string): string | undefined {
  if (!nano) return undefined;
  return new Date(Number(BigInt(nano) / 1_000_000n)).toISOString();
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

// GenAI request-parameter attributes → modelParameters (only the ones present).
function modelParameters(attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  const map: Record<string, string> = {
    temperature: "gen_ai.request.temperature",
    topP: "gen_ai.request.top_p",
    topK: "gen_ai.request.top_k",
    maxTokens: "gen_ai.request.max_tokens",
    frequencyPenalty: "gen_ai.request.frequency_penalty",
    presencePenalty: "gen_ai.request.presence_penalty",
    stopSequences: "gen_ai.request.stop_sequences",
    seed: "gen_ai.request.seed",
  };
  const out: Record<string, unknown> = {};
  for (const [k, attr] of Object.entries(map)) if (attrs[attr] !== undefined) out[k] = attrs[attr];
  return Object.keys(out).length > 0 ? out : undefined;
}

export function otlpToEvents(payload: OtlpPayload): IngestEvent[] {
  const events: IngestEvent[] = [];
  const seenTraces = new Set<string>();

  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs: Record<string, unknown> = {};
    for (const a of rs.resource?.attributes ?? []) resourceAttrs[a.key] = attrValue(a);
    const environment = str(
      resourceAttrs["deployment.environment.name"] ?? resourceAttrs["deployment.environment"] ?? "default",
    ) as string;
    const release = str(resourceAttrs["service.version"]);

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs: Record<string, unknown> = {};
        for (const a of span.attributes ?? []) attrs[a.key] = attrValue(a);

        const start = nanoToIso(span.startTimeUnixNano) ?? new Date().toISOString();
        const end = nanoToIso(span.endTimeUnixNano);
        // OpenInference (openinference.span.kind) — the semconv Phoenix + its 30+ framework
        // instrumentors emit. LLM spans become generations; the RAG/agent kinds map to our
        // observation types. Non-OpenInference OTLP GenAI still routes via the gen_ai.* check.
        const oiKind = str(attrs["openinference.span.kind"])?.toUpperCase();
        const OI_TO_TYPE: Record<string, ObservationType> = {
          RETRIEVER: "RETRIEVER",
          RERANKER: "RERANKER",
          EMBEDDING: "EMBEDDING",
          CHAIN: "CHAIN",
          TOOL: "TOOL",
          AGENT: "AGENT",
          GUARDRAIL: "GUARDRAIL",
        };
        const isGen = oiKind === "LLM" || Object.keys(attrs).some((k) => k.startsWith("gen_ai."));
        const level: "ERROR" | "DEFAULT" = span.status?.code === 2 ? "ERROR" : "DEFAULT";
        // MCP (Model Context Protocol) semconv: name the observation after the tool (for a
        // tools/call) or the method, so MCP calls are first-class in the waterfall AND land
        // in the by-tool analytics next to other tools. Raw mcp.* attrs stay in metadata.
        const mcpMethod = str(attrs["mcp.method.name"]);
        const mcpName = mcpMethod
          ? `mcp:${str(attrs["mcp.tool.name"]) ?? str(attrs["mcp.prompt.name"]) ?? mcpMethod}`
          : undefined;

        if (!seenTraces.has(span.traceId)) {
          seenTraces.add(span.traceId);
          events.push({
            id: newId(),
            type: "trace-create",
            timestamp: start,
            body: {
              id: span.traceId,
              name: span.name ?? str(resourceAttrs["service.name"]) ?? "otel-trace",
              environment,
              release,
              sessionId: str(attrs["gen_ai.conversation.id"] ?? attrs["mcp.session.id"] ?? attrs["session.id"]),
              userId: str(attrs["gen_ai.user.id"] ?? attrs["enduser.id"] ?? attrs["user.id"]),
            },
          });
        }

        const base = {
          id: span.spanId,
          traceId: span.traceId,
          parentObservationId: span.parentSpanId || undefined,
          name: mcpName ?? span.name,
          startTime: start,
          endTime: end,
          environment,
          level,
          statusMessage: span.status?.message,
          metadata: attrs,
        };

        if (isGen) {
          // Token/model/io fall back across OTLP GenAI (gen_ai.*) and OpenInference (llm.*).
          const promptTokens = Number(
            attrs["gen_ai.usage.input_tokens"] ??
              attrs["gen_ai.usage.prompt_tokens"] ??
              attrs["llm.token_count.prompt"] ??
              0,
          );
          const completionTokens = Number(
            attrs["gen_ai.usage.output_tokens"] ??
              attrs["gen_ai.usage.completion_tokens"] ??
              attrs["llm.token_count.completion"] ??
              0,
          );
          events.push({
            id: newId(),
            type: "generation-create",
            timestamp: end ?? start,
            body: {
              ...base,
              model: String(
                attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"] ?? attrs["llm.model_name"] ?? "",
              ),
              provider: String(
                attrs["gen_ai.provider.name"] ??
                  attrs["gen_ai.system"] ??
                  attrs["llm.provider"] ??
                  attrs["llm.system"] ??
                  "",
              ),
              modelParameters: modelParameters(attrs),
              usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
              // Newer semconv uses gen_ai.input/output.messages; fall back to prompt/completion, then OpenInference.
              input:
                attrs["gen_ai.input.messages"] ??
                attrs["gen_ai.prompt"] ??
                attrs["llm.input_messages"] ??
                attrs["input.value"],
              output:
                attrs["gen_ai.output.messages"] ??
                attrs["gen_ai.completion"] ??
                attrs["llm.output_messages"] ??
                attrs["output.value"],
            },
          });
        } else {
          // Classify the span by its OpenInference kind (retriever/reranker/embedding/chain/
          // tool/agent/guardrail); other kinds stay a plain SPAN.
          const observationType = oiKind ? OI_TO_TYPE[oiKind] : undefined;
          events.push({
            id: newId(),
            type: "span-create",
            timestamp: end ?? start,
            body: observationType ? { ...base, observationType } : base,
          });
        }
      }
    }
  }

  return events;
}
