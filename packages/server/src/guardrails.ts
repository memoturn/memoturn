import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { applyMasking, BUILTIN_NAMES, BUILTIN_PATTERNS, compileMaskers } from "./masking.js";

/**
 * Runtime guardrails — the request-time sibling of masking. An SDK-callable endpoint
 * (POST /v1/guardrails/check) scans a piece of text against a per-project policy for PII
 * (reusing the masking builtin patterns), prompt-injection heuristics, and blocked terms,
 * returning allow / redact / block. The scan itself is a pure function (unit-tested).
 */
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string) => `memoturn:guardrail:${projectId}`;

// High-precision prompt-injection heuristics (case-insensitive). Intentionally conservative
// to avoid false positives on normal content; a model-based detector can layer on later.
const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "ignore-instructions",
    re: /ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|directions?|rules?|messages?)/i,
  },
  {
    name: "disregard-instructions",
    re: /disregard\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|context)/i,
  },
  {
    name: "forget-context",
    re: /forget\s+(?:everything|all|(?:the\s+)?above|(?:all\s+)?(?:previous|prior)\s+(?:instructions?|context))/i,
  },
  {
    name: "reveal-system-prompt",
    re: /(?:reveal|show|print|repeat|output|display|tell\s+me)\s+(?:your\s+|the\s+|me\s+your\s+)?(?:system\s+)?(?:prompt|instructions?)/i,
  },
  { name: "role-override", re: /you\s+are\s+now\s+(?:a\b|an\b|the\b|no\s+longer)/i },
  { name: "new-instructions", re: /(?:new|updated|revised)\s+instructions?\s*[:-]/i },
  { name: "jailbreak", re: /\b(?:jailbreak|DAN\s+mode|developer\s+mode)\b/i },
];

export type GuardrailVerdict = "allow" | "redact" | "block";

export interface GuardrailFinding {
  category: "pii" | "injection" | "blocked_term";
  /** Pattern/term name, e.g. "email", "ignore-instructions", or the blocked term itself. */
  type: string;
  count: number;
}

export interface GuardrailPolicy {
  enabled: boolean;
  pii: boolean;
  piiAction: "redact" | "block";
  builtins: string[];
  customPatterns: string[];
  redactWith: string;
  injection: boolean;
  blockedTerms: string[];
}

export interface GuardrailResult {
  verdict: GuardrailVerdict;
  findings: GuardrailFinding[];
  /** Present only when the verdict is "redact": the input with PII replaced. */
  redactedText?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure guardrail scan. PII hits redact (or block, per policy); prompt-injection hits and
 * blocked-term hits always block. A block outranks a redact outranks allow.
 */
export function scanGuardrails(text: string, policy: GuardrailPolicy): GuardrailResult {
  const findings: GuardrailFinding[] = [];
  let block = false;
  let redactedText: string | undefined;

  if (policy.pii) {
    // Named sources so each hit is attributable in the findings; the masking engine does the
    // actual redaction from the same builtin+custom set.
    const named = [
      ...policy.builtins
        .filter((b) => BUILTIN_PATTERNS[b])
        .map((b) => ({ name: b, src: BUILTIN_PATTERNS[b] as string })),
      ...policy.customPatterns.map((src, i) => ({ name: `custom_${i + 1}`, src })),
    ];
    let piiFound = false;
    for (const { name, src } of named) {
      let re: RegExp;
      try {
        re = new RegExp(src, "g");
      } catch {
        continue; // skip invalid custom regex
      }
      const count = (text.match(re) ?? []).length;
      if (count > 0) {
        findings.push({ category: "pii", type: name, count });
        piiFound = true;
      }
    }
    if (piiFound) {
      if (policy.piiAction === "block") block = true;
      else {
        const maskers = compileMaskers({
          enabled: true,
          builtins: policy.builtins,
          customPatterns: policy.customPatterns,
          redactWith: policy.redactWith,
        });
        redactedText = applyMasking(text, maskers) as string;
      }
    }
  }

  if (policy.injection) {
    for (const { name, re } of INJECTION_PATTERNS) {
      if (re.test(text)) {
        findings.push({ category: "injection", type: name, count: 1 });
        block = true;
      }
    }
  }

  for (const term of policy.blockedTerms) {
    if (!term) continue;
    const count = (text.match(new RegExp(escapeRegExp(term), "gi")) ?? []).length;
    if (count > 0) {
      findings.push({ category: "blocked_term", type: term, count });
      block = true;
    }
  }

  const verdict: GuardrailVerdict = block ? "block" : redactedText !== undefined ? "redact" : "allow";
  return { verdict, findings, ...(redactedText !== undefined ? { redactedText } : {}) };
}

// Unconfigured projects scan with everything on, so the endpoint is useful out of the box.
const SCAN_DEFAULT: GuardrailPolicy = {
  enabled: true,
  pii: true,
  piiAction: "redact",
  builtins: BUILTIN_NAMES,
  customPatterns: [],
  redactWith: "[REDACTED]",
  injection: true,
  blockedTerms: [],
};

// The starter config shown in the console when nothing is saved yet (disabled by default).
const CONFIG_DEFAULT: GuardrailPolicy = { ...SCAN_DEFAULT, enabled: false };

export async function getGuardrailPolicy(projectId: string): Promise<GuardrailPolicy & { available: string[] }> {
  const p = await prisma.guardrailPolicy.findUnique({ where: { projectId } });
  const policy: GuardrailPolicy = p
    ? {
        enabled: p.enabled,
        pii: p.pii,
        piiAction: p.piiAction === "block" ? "block" : "redact",
        builtins: p.builtins,
        customPatterns: p.customPatterns,
        redactWith: p.redactWith,
        injection: p.injection,
        blockedTerms: p.blockedTerms,
      }
    : CONFIG_DEFAULT;
  return { ...policy, available: BUILTIN_NAMES };
}

export interface SetGuardrailInput {
  enabled?: boolean;
  pii?: boolean;
  piiAction?: "redact" | "block";
  builtins?: string[];
  customPatterns?: string[];
  redactWith?: string;
  injection?: boolean;
  blockedTerms?: string[];
}

export async function setGuardrailPolicy(projectId: string, input: SetGuardrailInput) {
  const data = {
    enabled: input.enabled ?? false,
    pii: input.pii ?? true,
    piiAction: input.piiAction === "block" ? "block" : "redact",
    builtins: (input.builtins ?? []).filter((b) => BUILTIN_NAMES.includes(b)),
    customPatterns: input.customPatterns ?? [],
    redactWith: input.redactWith || "[REDACTED]",
    injection: input.injection ?? true,
    blockedTerms: (input.blockedTerms ?? []).map((t) => t.trim()).filter(Boolean),
  };
  const p = await prisma.guardrailPolicy.upsert({ where: { projectId }, update: data, create: { projectId, ...data } });
  await bustCache(projectId);
  return { ...toPolicy(p), available: BUILTIN_NAMES };
}

/**
 * Resolve the policy the /check endpoint scans with (Redis-cached). Returns `null` when the
 * project has explicitly disabled guardrails; unconfigured projects scan with SCAN_DEFAULT.
 */
export async function loadGuardrailPolicy(projectId: string): Promise<GuardrailPolicy | null> {
  try {
    const raw = await redisConnection().get(cacheKey(projectId));
    if (raw) return JSON.parse(raw) as GuardrailPolicy | null;
  } catch {
    // fall through to DB
  }
  const p = await prisma.guardrailPolicy.findUnique({ where: { projectId } });
  const resolved: GuardrailPolicy | null = !p ? SCAN_DEFAULT : p.enabled ? toPolicy(p) : null;
  try {
    await redisConnection().set(cacheKey(projectId), JSON.stringify(resolved), "EX", CACHE_TTL_SECONDS);
  } catch {
    // best-effort
  }
  return resolved;
}

function toPolicy(p: {
  enabled: boolean;
  pii: boolean;
  piiAction: string;
  builtins: string[];
  customPatterns: string[];
  redactWith: string;
  injection: boolean;
  blockedTerms: string[];
}): GuardrailPolicy {
  return {
    enabled: p.enabled,
    pii: p.pii,
    piiAction: p.piiAction === "block" ? "block" : "redact",
    builtins: p.builtins,
    customPatterns: p.customPatterns,
    redactWith: p.redactWith,
    injection: p.injection,
    blockedTerms: p.blockedTerms,
  };
}

async function bustCache(projectId: string) {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}
