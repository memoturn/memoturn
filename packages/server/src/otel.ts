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
interface OtlpPayload {
  resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
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

export function otlpToEvents(payload: OtlpPayload): IngestEvent[] {
  const events: IngestEvent[] = [];
  const seenTraces = new Set<string>();

  for (const rs of payload.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs: Record<string, unknown> = {};
        for (const a of span.attributes ?? []) attrs[a.key] = attrValue(a);

        const start = nanoToIso(span.startTimeUnixNano) ?? new Date().toISOString();
        const end = nanoToIso(span.endTimeUnixNano);
        const isGen = Object.keys(attrs).some((k) => k.startsWith("gen_ai."));

        if (!seenTraces.has(span.traceId)) {
          seenTraces.add(span.traceId);
          events.push({
            id: newId(),
            type: "trace-create",
            timestamp: start,
            body: { id: span.traceId, name: span.name ?? "otel-trace", environment: "default" },
          });
        }

        const base = {
          id: span.spanId,
          traceId: span.traceId,
          parentObservationId: span.parentSpanId || undefined,
          name: span.name,
          startTime: start,
          endTime: end,
          environment: "default",
          statusMessage: span.status?.message,
          metadata: attrs,
        };

        if (isGen) {
          const promptTokens = Number(attrs["gen_ai.usage.input_tokens"] ?? attrs["gen_ai.usage.prompt_tokens"] ?? 0);
          const completionTokens = Number(attrs["gen_ai.usage.output_tokens"] ?? attrs["gen_ai.usage.completion_tokens"] ?? 0);
          events.push({
            id: newId(),
            type: "generation-create",
            timestamp: end ?? start,
            body: {
              ...base,
              model: String(attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"] ?? ""),
              provider: String(attrs["gen_ai.system"] ?? ""),
              usage: { promptTokens, completionTokens },
              input: attrs["gen_ai.prompt"],
              output: attrs["gen_ai.completion"],
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
