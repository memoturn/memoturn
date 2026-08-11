import type { EvaluatorVariableBinding, EvaluatorVariableSource } from "@memoturn/contracts";

/**
 * Judge-prompt variable mapping.
 *
 * Without it every judge sees exactly `{input, output, expectedOutput}` of the trace — which
 * makes whole classes of judge impossible to express: "is the retrieved context relevant to
 * the question?" needs the *retriever span's* output, not the final answer. A mapping binds
 * each variable the prompt references to a chosen source (a trace field, a NAMED observation's
 * field, or a dataset-item field), optionally reaching into it with a dotted path.
 *
 * Two design rules, both about not breaking judges in production:
 *  - An empty mapping keeps the built-in binding, so existing evaluators are untouched.
 *  - An unresolvable binding yields `null` rather than throwing. A judge that can't see one
 *    variable should score badly or say so — it should not fail ingestion.
 */

/** What a mapping can read from. Mirrors `evaluatorVariableSource` in @memoturn/contracts. */
const SOURCES = new Set<string>([
  "trace.input",
  "trace.output",
  "trace.metadata",
  "observation.input",
  "observation.output",
  "observation.metadata",
  "dataset.input",
  "dataset.expectedOutput",
  "dataset.metadata",
]);

/** The material a mapping resolves against. Every part is optional — bindings that reference a
 *  missing part resolve to null. */
export interface VariableContext {
  trace?: { input?: unknown; output?: unknown; metadata?: unknown };
  /** The trace's spans, for `observation.*` bindings. Order matters: first name match wins. */
  observations?: { name?: string; input?: unknown; output?: unknown; metadata?: unknown }[];
  dataset?: { input?: unknown; expectedOutput?: unknown; metadata?: unknown };
}

/** Coerce the Prisma Json `variableMapping` column into clean bindings (tolerant of bad rows). */
export function parseVariableMapping(json: unknown): EvaluatorVariableBinding[] {
  if (!Array.isArray(json)) return [];
  const out: EvaluatorVariableBinding[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Partial<EvaluatorVariableBinding>;
    const variable = typeof b.variable === "string" ? b.variable.trim() : "";
    const source = typeof b.source === "string" ? b.source : "";
    if (!variable || !SOURCES.has(source)) continue;
    out.push({
      variable,
      source: source as EvaluatorVariableSource,
      observationName: typeof b.observationName === "string" ? b.observationName : "",
      jsonPath: typeof b.jsonPath === "string" ? b.jsonPath : "",
    });
  }
  return out;
}

/** True when any binding reads from a span — i.e. the caller must supply the trace's
 *  observations or those variables will bind to null. */
export function mappingNeedsObservations(mapping: EvaluatorVariableBinding[]): boolean {
  return mapping.some((b) => b.source.startsWith("observation."));
}

/** Parse a value that may be a JSON-encoded string; non-JSON strings are returned as-is. */
function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Walk a dotted path (`choices.0.text`) into a value; undefined when any hop is missing. */
function walk(value: unknown, path: string): unknown {
  let cur = maybeJson(value);
  for (const seg of path.split(".")) {
    if (seg === "") continue;
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    cur = typeof cur === "string" ? cur : maybeJson(cur);
  }
  return cur;
}

function pick(ctx: VariableContext, binding: EvaluatorVariableBinding): unknown {
  const [scope, field] = binding.source.split(".") as [string, "input" | "output" | "metadata" | "expectedOutput"];
  if (scope === "trace") return ctx.trace?.[field as "input" | "output" | "metadata"];
  if (scope === "dataset") return ctx.dataset?.[field as "input" | "expectedOutput" | "metadata"];
  // observation: first span whose name matches, or the first span when no name is given.
  const spans = ctx.observations ?? [];
  const span = binding.observationName ? spans.find((o) => o.name === binding.observationName) : spans[0];
  return span?.[field as "input" | "output" | "metadata"];
}

/**
 * Resolve every binding into the payload handed to the judge. Values keep their natural shape
 * (an object stays an object) so the judge sees structure, not a stringified blob.
 */
export function resolveVariables(mapping: EvaluatorVariableBinding[], ctx: VariableContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of mapping) {
    const base = pick(ctx, b);
    const value = b.jsonPath ? walk(base, b.jsonPath) : maybeJson(base);
    out[b.variable] = value === undefined ? null : value;
  }
  return out;
}

/** Substitute `{{variable}}` references in a judge prompt. Unknown names are left untouched
 *  (a literal `{{foo}}` in the prompt is more debuggable than a silent empty string). */
export function renderPrompt(prompt: string, vars: Record<string, unknown>): string {
  return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const v = vars[name];
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}
