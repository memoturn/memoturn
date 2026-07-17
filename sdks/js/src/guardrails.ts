import type { Creds } from "./dataset.js";
import { basicAuth, DEFAULT_REQUEST_TIMEOUT_MS, truncate } from "./internal.js";

export interface GuardrailFinding {
  category: "pii" | "injection" | "blocked_term";
  type: string;
  count: number;
}

export interface GuardrailVerdict {
  verdict: "allow" | "redact" | "block";
  findings: GuardrailFinding[];
  /** Present only when the verdict is "redact": the input with PII replaced. */
  redactedText?: string;
}

/**
 * Scan a piece of text against the project's runtime guardrails (PII, prompt injection,
 * blocked terms) and get a verdict. Call this before sending user content to an LLM, or
 * before returning a model's output. Returns "allow", "redact" (with `redactedText`), or
 * "block".
 */
export async function checkGuardrails(creds: Creds, text: string): Promise<GuardrailVerdict> {
  const baseUrl = (creds.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const publicKey = creds.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = creds.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
  const res = await fetch(`${baseUrl}/v1/guardrails/check`, {
    method: "POST",
    headers: { authorization: basicAuth(publicKey, secretKey), "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(creds.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`guardrails check failed: ${res.status} ${truncate(await res.text())}`);
  return res.json() as Promise<GuardrailVerdict>;
}

/** Thrown by `runGuarded` (default `onFailure: "raise"`) when a "block" verdict is hit. */
export class GuardrailBlockedError extends Error {
  constructor(public readonly verdict: GuardrailVerdict) {
    super(`memoturn: content blocked by guardrails (${verdict.findings.map((f) => f.type).join(", ")})`);
  }
}

export type OnGuardFailure<T> = "raise" | "log" | { fallback: T | ((verdict: GuardrailVerdict) => T) };

export interface RunGuardedOptions<T> {
  creds?: Creds;
  /** Extract the text to scan from `fn`'s resolved value. Defaults to `String(result)`. */
  extractText?: (result: T) => string;
  /** What to do on a "block" verdict. Default `"raise"` — see the note below. */
  onFailure?: OnGuardFailure<T>;
}

/**
 * Run `fn`, scan its resolved value with `checkGuardrails`, and apply `onFailure` semantics on
 * a "block" verdict. Compose two calls to guard both input and output separately, e.g.:
 *
 *   const safeInput = await runGuarded(() => userInput);
 *   const answer = await runGuarded(() => callModel(safeInput));
 *
 * Default `onFailure: "raise"` is deliberate — unlike `MaskFunction` (which swallows its own
 * errors, because masking protects a side-channel that must never break the app), guardrails
 * exist specifically to block unsafe content; silently swallowing a block by default would
 * defeat the feature. Pass `"log"` or `{ fallback }` to opt into softer handling.
 *
 * A "redact" verdict is returned as-is: substituting `redactedText` for the actual content is
 * the caller's/server's job (via the raw `checkGuardrails` verdict) — this wrapper only makes
 * the block/pass decision.
 */
export async function runGuarded<T>(fn: () => T | Promise<T>, options?: RunGuardedOptions<T>): Promise<T> {
  const result = await fn();
  const text = (options?.extractText ?? String)(result);
  const verdict = await checkGuardrails(options?.creds ?? {}, text);

  if (verdict.verdict !== "block") return result;

  const onFailure = options?.onFailure ?? "raise";
  if (onFailure === "raise") throw new GuardrailBlockedError(verdict);
  if (onFailure === "log") {
    console.warn(`memoturn: guardrails blocked content (${verdict.findings.map((f) => f.type).join(", ")})`, verdict);
    return result;
  }
  return typeof onFailure.fallback === "function"
    ? (onFailure.fallback as (verdict: GuardrailVerdict) => T)(verdict)
    : onFailure.fallback;
}
