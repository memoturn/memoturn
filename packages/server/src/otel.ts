import { type IngestEvent, newId } from "@memoturn/core";

/**
 * Minimal OTLP/JSON → memoturn ingest mapping for GenAI spans. Accepts the standard
 * OTLP traces JSON payload and maps each span to an observation, emitting a
 * trace-create per distinct OTel traceId. Spans carrying `gen_ai.*` attributes become
 * GENERATIONs; everything else becomes a SPAN. (OTLP/protobuf support is Phase 2.)
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
        const isGen = Object.keys(attrs).some((k) => k.startsWith("gen_ai."));
        const level: "ERROR" | "DEFAULT" = span.status?.code === 2 ? "ERROR" : "DEFAULT";

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
              sessionId: str(attrs["gen_ai.conversation.id"] ?? attrs["session.id"]),
              userId: str(attrs["gen_ai.user.id"] ?? attrs["enduser.id"] ?? attrs["user.id"]),
            },
          });
        }

        const base = {
          id: span.spanId,
          traceId: span.traceId,
          parentObservationId: span.parentSpanId || undefined,
          name: span.name,
          startTime: start,
          endTime: end,
          environment,
          level,
          statusMessage: span.status?.message,
          metadata: attrs,
        };

        if (isGen) {
          const promptTokens = Number(attrs["gen_ai.usage.input_tokens"] ?? attrs["gen_ai.usage.prompt_tokens"] ?? 0);
          const completionTokens = Number(
            attrs["gen_ai.usage.output_tokens"] ?? attrs["gen_ai.usage.completion_tokens"] ?? 0,
          );
          events.push({
            id: newId(),
            type: "generation-create",
            timestamp: end ?? start,
            body: {
              ...base,
              model: String(attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"] ?? ""),
              provider: String(attrs["gen_ai.provider.name"] ?? attrs["gen_ai.system"] ?? ""),
              modelParameters: modelParameters(attrs),
              usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
              // Newer semconv uses gen_ai.input/output.messages; fall back to prompt/completion.
              input: attrs["gen_ai.input.messages"] ?? attrs["gen_ai.prompt"],
              output: attrs["gen_ai.output.messages"] ?? attrs["gen_ai.completion"],
            },
          });
        } else {
          events.push({ id: newId(), type: "span-create", timestamp: end ?? start, body: base });
        }
      }
    }
  }

  return events;
}
