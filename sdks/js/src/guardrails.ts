import type { Creds } from "./dataset.js";

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
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const res = await fetch(`${baseUrl}/v1/guardrails/check`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`guardrails check failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<GuardrailVerdict>;
}
