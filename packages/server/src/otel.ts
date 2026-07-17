import { type IngestEvent, newId, type ObservationType } from "@memoturn/core";

/**
 * OTLP → memoturn ingest mapping. Accepts OTLP traces as JSON or protobuf (see
 * decodeOtlpTraces) and maps each span to an observation, emitting a trace-create per
 * distinct OTel traceId. Also reads OTLP span *events* (Span.events[], distinct from span
 * attributes) for `gen_ai.evaluation.result`, mapped to an EVAL score-create.
 *
 * Span classification checks OpenInference (`openinference.span.kind`) first — the
 * broadest-adopted, most explicit convention — then falls through classifySpan's chain:
 * generic `gen_ai.operation.name` (covers Vercel AI SDK v7+, LiveKit Agents, Flue, and any
 * other framework converging on the OTel GenAI semconv directly), legacy Vercel AI SDK
 * (pre-v7 `ai.*` namespace), Genkit (`genkit:metadata:subtype`), and LiveKit Agents span
 * names (weakest signal, checked last). Everything unclassified stays a plain SPAN.
 */

interface OtlpAttr {
  key: string;
  value?: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}
/** A span event (OTLP `Span.events[]`) — distinct from top-level span attributes. Used for
 *  `gen_ai.evaluation.result`, the OTel GenAI semconv's way of reporting an eval score. */
interface OtlpSpanEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: OtlpAttr[];
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttr[];
  events?: OtlpSpanEvent[];
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

function decodeSpanEvent(b: Uint8Array): OtlpSpanEvent {
  const r = new PbReader(b);
  const ev: OtlpSpanEvent = { attributes: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 1) ev.timeUnixNano = r.fixed64u().toString();
    else if (field === 2 && wire === 2) ev.name = r.string();
    else if (field === 3 && wire === 2) ev.attributes?.push(decodeKeyValue(r.bytes()));
    else r.skip(wire);
  }
  return ev;
}

function decodeSpan(b: Uint8Array): OtlpSpan {
  const r = new PbReader(b);
  const span: OtlpSpan = { traceId: "", spanId: "", attributes: [], events: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) span.traceId = hex(r.bytes());
    else if (field === 2 && wire === 2) span.spanId = hex(r.bytes());
    else if (field === 4 && wire === 2) span.parentSpanId = hex(r.bytes());
    else if (field === 5 && wire === 2) span.name = r.string();
    else if (field === 7 && wire === 1) span.startTimeUnixNano = r.fixed64u().toString();
    else if (field === 8 && wire === 1) span.endTimeUnixNano = r.fixed64u().toString();
    else if (field === 9 && wire === 2) span.attributes?.push(decodeKeyValue(r.bytes()));
    else if (field === 11 && wire === 2) span.events?.push(decodeSpanEvent(r.bytes()));
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

// OpenInference flattens retrieved docs as `retrieval.documents.{i}.document.{content|score|id|
// metadata}` attributes. Regroup them by index into memoturn's structured retrieval documents
// (rank = list position), so a RETRIEVER span renders its ranked docs + relevance in the UI.
const OI_DOC_RE = /^retrieval\.documents\.(\d+)\.document\.(content|score|id|metadata)$/;
function openInferenceDocs(
  attrs: Record<string, unknown>,
): { rank: number; content: string; score?: number; id?: string; metadata?: unknown }[] | undefined {
  const byIdx = new Map<number, { content?: string; score?: number; id?: string; metadata?: unknown }>();
  for (const [k, v] of Object.entries(attrs)) {
    const m = OI_DOC_RE.exec(k);
    if (!m) continue;
    const idx = Number(m[1]);
    const d = byIdx.get(idx) ?? {};
    if (m[2] === "content") d.content = String(v);
    else if (m[2] === "score") d.score = Number(v);
    else if (m[2] === "id") d.id = str(v);
    else d.metadata = v;
    byIdx.set(idx, d);
  }
  if (byIdx.size === 0) return undefined;
  return [...byIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rank, d]) => ({
      rank,
      content: d.content ?? "",
      ...(d.score !== undefined && !Number.isNaN(d.score) && { score: d.score }),
      ...(d.id && { id: d.id }),
      ...(d.metadata !== undefined && { metadata: d.metadata }),
    }));
}

// gen_ai.operation.name → observation type. This is the OTel GenAI semconv's own span-kind
// discriminator, and what newer framework instrumentations (Vercel AI SDK v7+'s @ai-sdk/otel,
// LiveKit Agents, Flue) converge on emitting directly — checking it generically covers all of
// them without per-framework special-casing.
const GEN_AI_OP_TO_TYPE: Record<string, ObservationType | "GENERATION"> = {
  chat: "GENERATION",
  generate_content: "GENERATION",
  text_completion: "GENERATION",
  generate: "GENERATION",
  embeddings: "EMBEDDING",
  execute_tool: "TOOL",
  invoke_agent: "AGENT",
  create_agent: "AGENT",
  invoke_workflow: "CHAIN",
};

// Genkit (genkit:metadata:subtype, from its ActionType union) → observation type. `evaluator`
// is intentionally left unmapped: it's a quality-scoring step, not a pass/fail safety check
// like GUARDRAIL, and there's no EVALUATOR type in this taxonomy — adding one is a bigger
// cross-stack change (enum + Doris column + console filters) than this mapping warrants.
const GENKIT_SUBTYPE_TO_TYPE: Record<string, ObservationType | "GENERATION"> = {
  model: "GENERATION",
  "background-model": "GENERATION",
  embedder: "EMBEDDING",
  tool: "TOOL",
  "tool.v2": "TOOL",
  retriever: "RETRIEVER",
  reranker: "RERANKER",
  agent: "AGENT",
  "agent-snapshot": "AGENT",
  flow: "CHAIN",
};

/**
 * Classifies a span beyond the OpenInference check done inline in otlpToEvents (highest
 * priority, checked by the caller first since it's the broadest-adopted, most explicit
 * convention). Priority here: generic gen_ai.operation.name → gen_ai.tool.name fallback (e.g.
 * Pydantic AI, which sets the tool attrs without an operation.name) → legacy Vercel AI SDK
 * (pre-v7 ai.* namespace) → Genkit → LiveKit Agents span names (weakest signal, name-based,
 * so checked last).
 */
function classifySpan(
  attrs: Record<string, unknown>,
  spanName: string | undefined,
): ObservationType | "GENERATION" | undefined {
  const genAiOp = str(attrs["gen_ai.operation.name"])?.toLowerCase();
  if (genAiOp && GEN_AI_OP_TO_TYPE[genAiOp]) return GEN_AI_OP_TO_TYPE[genAiOp];
  if (attrs["gen_ai.tool.name"] !== undefined || attrs["gen_ai.tool.call.id"] !== undefined) return "TOOL";

  // Vercel AI SDK, pre-v7 (opt-in experimental_telemetry, ai.* namespace). Only the inner
  // *.doGenerate/*.doStream/*.doEmbed child spans represent an actual model call — the outer
  // ai.generateText/streamText/embed spans are orchestration wrappers that would double-count
  // cost/tokens per call if classified too.
  const aiOp = str(attrs["operation.name"] ?? attrs["ai.operationId"]);
  if (aiOp?.endsWith(".doGenerate") || aiOp?.endsWith(".doStream")) return "GENERATION";
  if (aiOp?.endsWith(".doEmbed")) return "EMBEDDING";
  if (aiOp === "ai.toolCall") return "TOOL";

  const genkitSubtype = str(attrs["genkit:metadata:subtype"])?.toLowerCase();
  if (genkitSubtype && GENKIT_SUBTYPE_TO_TYPE[genkitSubtype]) return GENKIT_SUBTYPE_TO_TYPE[genkitSubtype];

  // LiveKit Agents — span-name-based (weaker signal than an attribute, so lowest priority; a
  // name collision with an unrelated span using the same name is possible and accepted).
  if (spanName === "llm_request") return "GENERATION";
  if (spanName === "function_tool") return "TOOL";
  if (spanName === "start_agent_activity") return "AGENT";

  return undefined;
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
        // Classify via OpenInference first (highest priority), else the broader chain (generic
        // gen_ai.operation.name, Vercel AI SDK, Genkit, LiveKit — see classifySpan). Falling
        // back to "any gen_ai.*-prefixed attribute present" would misclassify e.g. a Flue
        // execute_tool span (which carries gen_ai.tool.name) as a generation — so the legacy
        // signal below is scoped to actual model-call attributes, not any gen_ai.* key.
        const classified: ObservationType | "GENERATION" | undefined =
          oiKind === "LLM"
            ? "GENERATION"
            : oiKind && OI_TO_TYPE[oiKind]
              ? OI_TO_TYPE[oiKind]
              : classifySpan(attrs, span.name);
        const legacyGenAiSignal =
          attrs["gen_ai.usage.input_tokens"] !== undefined ||
          attrs["gen_ai.usage.prompt_tokens"] !== undefined ||
          attrs["gen_ai.request.model"] !== undefined ||
          attrs["gen_ai.response.model"] !== undefined;
        const isGen = classified === "GENERATION" || (classified === undefined && legacyGenAiSignal);
        const observationType = classified && classified !== "GENERATION" ? classified : undefined;
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
          // Token/model/io fall back across OTLP GenAI (gen_ai.*), OpenInference (llm.*), and
          // legacy Vercel AI SDK pre-v7 (ai.*).
          const promptTokens = Number(
            attrs["gen_ai.usage.input_tokens"] ??
              attrs["gen_ai.usage.prompt_tokens"] ??
              attrs["llm.token_count.prompt"] ??
              attrs["ai.usage.promptTokens"] ??
              0,
          );
          const completionTokens = Number(
            attrs["gen_ai.usage.output_tokens"] ??
              attrs["gen_ai.usage.completion_tokens"] ??
              attrs["llm.token_count.completion"] ??
              attrs["ai.usage.completionTokens"] ??
              0,
          );
          events.push({
            id: newId(),
            type: "generation-create",
            timestamp: end ?? start,
            body: {
              ...base,
              model: String(
                attrs["gen_ai.response.model"] ??
                  attrs["gen_ai.request.model"] ??
                  attrs["llm.model_name"] ??
                  attrs["ai.model.id"] ??
                  "",
              ),
              provider: String(
                attrs["gen_ai.provider.name"] ??
                  attrs["gen_ai.system"] ??
                  attrs["llm.provider"] ??
                  attrs["llm.system"] ??
                  attrs["ai.model.provider"] ??
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
          // observationType is whatever classifySpan (or the OpenInference check above) landed
          // on, when it's not GENERATION; other kinds stay a plain SPAN. RETRIEVER spans also
          // carry their retrieved documents (retrieval.documents.*) → structured retrieval_documents.
          const retrievedDocuments = openInferenceDocs(attrs);
          events.push({
            id: newId(),
            type: "span-create",
            timestamp: end ?? start,
            body: {
              ...base,
              ...(observationType && { observationType }),
              ...(retrievedDocuments && { retrievedDocuments }),
            },
          });
        }

        // gen_ai.evaluation.result: the OTel GenAI semconv's way of reporting an eval score,
        // carried as a span event (not a span attribute) on the span it's scoring.
        for (const ev of span.events ?? []) {
          if (ev.name !== "gen_ai.evaluation.result") continue;
          const evAttrs: Record<string, unknown> = {};
          for (const a of ev.attributes ?? []) evAttrs[a.key] = attrValue(a);
          const evalName = str(evAttrs["gen_ai.evaluation.name"]);
          const scoreValue = evAttrs["gen_ai.evaluation.score.value"];
          const scoreLabel = str(evAttrs["gen_ai.evaluation.score.label"]);
          const explanation = str(evAttrs["gen_ai.evaluation.explanation"]);
          // Defensive: /v1/otel/v1/traces validates the whole mapped batch atomically, so a
          // malformed eval event must be dropped here rather than 400 the entire export.
          if (!evalName || (scoreValue === undefined && !scoreLabel)) continue;
          const comment = scoreLabel && explanation ? `${scoreLabel}: ${explanation}` : (explanation ?? scoreLabel);
          events.push({
            id: newId(),
            type: "score-create",
            timestamp: nanoToIso(ev.timeUnixNano) ?? end ?? start,
            body: {
              id: newId(),
              traceId: span.traceId,
              // The event lives on the span it's scoring — use the span's own id, NOT
              // gen_ai.response.id (a provider-side response id, a different namespace).
              observationId: span.spanId,
              name: evalName,
              environment,
              source: "EVAL",
              ...(scoreValue !== undefined
                ? { dataType: "NUMERIC" as const, value: Number(scoreValue) }
                : { dataType: "CATEGORICAL" as const, stringValue: scoreLabel as string }),
              ...(comment !== undefined && { comment }),
            },
          });
        }
      }
    }
  }

  return events;
}
