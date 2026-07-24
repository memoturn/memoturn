import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { generate, type Provider } from "@memoturn/llm";
import { judgeWithEvaluator, listEvaluators } from "./evaluators.js";
import { applyMasking, assertSafeUserPatterns, BUILTIN_NAMES, BUILTIN_PATTERNS, compileMaskers } from "./masking.js";
import { resolveProviderConfig } from "./providers.js";

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

// SQL-injection heuristics (case-insensitive). Same conservative, low-false-positive bias
// as INJECTION_PATTERNS — these catch obviously malicious payloads, not every valid SQL
// substring a legitimate user might type.
const SQL_INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "drop-table", re: /\bDROP\s+TABLE\b/i },
  { name: "union-select", re: /\bUNION\s+(?:ALL\s+)?SELECT\b/i },
  { name: "comment-terminator", re: /;\s*--/ },
  { name: "stacked-query", re: /;\s*(?:DROP|DELETE|UPDATE|INSERT|ALTER)\s+/i },
  { name: "xp-cmdshell", re: /\bxp_cmdshell\b/i },
  { name: "tautology", re: /\bOR\s+['"]?1['"]?\s*=\s*['"]?1['"]?/i },
  { name: "time-based", re: /\b(?:SLEEP|WAITFOR\s+DELAY)\s*\(/i },
];

export type GuardrailVerdict = "allow" | "redact" | "block";

export interface GuardrailFinding {
  category:
    | "pii"
    | "injection"
    | "blocked_term"
    | "sql_injection"
    | "json_invalid"
    | "evaluator"
    | "topic"
    | "toxicity";
  /** Pattern/term name, e.g. "email", "ignore-instructions", or the blocked term itself. */
  type: string;
  count: number;
  /** Judge score that caused an "evaluator" finding — see runEvaluatorGuards. */
  score?: number;
}

export interface EvaluatorGuard {
  /** Looked up by name, like runEvaluator. */
  name: string;
  comparator: "gt" | "gte" | "lt" | "lte";
  /** The guard FAILS (blocks) when `score <comparator> threshold` is true. */
  threshold: number;
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
  sqlInjection: boolean;
  /** Regexes that MUST match somewhere in the text; block if none do (inverse of blockedTerms). */
  requireMatch: string[];
  /** Require the text itself to parse as JSON. */
  requireValidJson: boolean;
  /** Top-level keys that must be present when the text parses as a JSON object. */
  requiredJsonKeys: string[];
  /** Opt-in LLM-judge guards, run only when the local scan hasn't already blocked. */
  evaluatorGuards: EvaluatorGuard[];
  // ── Built-in model guards (LLM-backed, fail-open) — the categories the deterministic scan
  // can't cover. `judgeProvider`/`judgeModel` is the LLM that classifies them.
  /** Block content about any of these topics (empty = off). */
  restrictedTopics: string[];
  /** Enable toxicity detection. */
  toxicity: boolean;
  /** Block when the toxicity score (0..1, 1 = clearly toxic) is ≥ this. */
  toxicityThreshold: number;
  /** Provider for the built-in topic/toxicity model guards. */
  judgeProvider: string;
  /** Model for the built-in topic/toxicity model guards. */
  judgeModel: string;
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

function clamp01(n: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
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

  if (policy.sqlInjection) {
    for (const { name, re } of SQL_INJECTION_PATTERNS) {
      if (re.test(text)) {
        findings.push({ category: "sql_injection", type: name, count: 1 });
        block = true;
      }
    }
  }

  if (policy.requireMatch.length > 0) {
    const matchedAny = policy.requireMatch.some((src) => {
      try {
        return new RegExp(src).test(text);
      } catch {
        return false; // an invalid regex never satisfies the requirement
      }
    });
    if (!matchedAny) {
      findings.push({ category: "blocked_term", type: "require_match", count: 1 });
      block = true;
    }
  }

  if (policy.requireValidJson || policy.requiredJsonKeys.length > 0) {
    let parsed: unknown;
    let validJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      validJson = false;
    }
    if (!validJson) {
      if (policy.requireValidJson) {
        findings.push({ category: "json_invalid", type: "invalid_json", count: 1 });
        block = true;
      }
    } else if (policy.requiredJsonKeys.length > 0) {
      const obj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      const missing = policy.requiredJsonKeys.filter((k) => !Object.hasOwn(obj, k));
      if (missing.length > 0) {
        findings.push({ category: "json_invalid", type: `missing_keys:${missing.join(",")}`, count: missing.length });
        block = true;
      }
    }
  }

  const verdict: GuardrailVerdict = block ? "block" : redactedText !== undefined ? "redact" : "allow";
  return { verdict, findings, ...(redactedText !== undefined ? { redactedText } : {}) };
}

const GUARD_TIMEOUT_MS = Number(process.env.GUARDRAIL_EVALUATOR_TIMEOUT_MS ?? 3000);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** True when the guard condition is violated (score fails the check → block). */
function guardFails(score: number, comparator: EvaluatorGuard["comparator"], threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return score > threshold;
    case "gte":
      return score >= threshold;
    case "lt":
      return score < threshold;
    case "lte":
      return score <= threshold;
  }
}

/**
 * Run evaluator-backed guards in parallel and return findings for the ones that failed.
 *
 * Fails OPEN on timeout, error, or a missing evaluator (`judgeWithEvaluator` returns null):
 * this mirrors the house invariant "online eval failures never fail ingestion" (see the
 * worker's online-eval sampling in apps/worker/src/processors/ingest.ts), applied to the
 * request path. A third-party LLM-judge-provider outage or slowness must not become a
 * primary-product (guardrail-check) outage. The deterministic regex/local checks in
 * scanGuardrails are the hard backstop and are unaffected by this tradeoff — only the
 * opt-in evaluator guards degrade gracefully.
 */
export async function runEvaluatorGuards(
  projectId: string,
  text: string,
  guards: EvaluatorGuard[],
): Promise<GuardrailFinding[]> {
  const settled = await Promise.allSettled(
    guards.map((g) =>
      withTimeout(judgeWithEvaluator(projectId, g.name, { input: text, output: text }), GUARD_TIMEOUT_MS),
    ),
  );

  const findings: GuardrailFinding[] = [];
  settled.forEach((result, i) => {
    const g = guards[i] as EvaluatorGuard;
    if (result.status === "fulfilled" && result.value !== null) {
      const { score } = result.value;
      if (guardFails(score, g.comparator, g.threshold)) {
        findings.push({ category: "evaluator", type: g.name, count: 1, score });
      }
      return;
    }
    const error =
      result.status === "rejected"
        ? result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
        : "evaluator not found";
    console.error(JSON.stringify({ scope: "guardrails.evaluatorGuard", projectId, guard: g.name, error }));
  });
  return findings;
}

// ── Built-in model guards (restricted topics + toxicity) ──────────────────────────────

const TOXICITY_JUDGE_PROMPT =
  "You are a content-safety classifier. Given a piece of text, rate how TOXIC it is — " +
  "harmful, hateful, harassing, threatening, violent, sexual, or otherwise unsafe content. " +
  'Respond ONLY with strict JSON: {"score": <number 0..1, where 1 = clearly toxic and 0 = completely safe>, "reasoning": <string>}.';

function topicJudgePrompt(topics: string[]): string {
  return (
    "You are a topic classifier. Decide whether the text is about any of these RESTRICTED topics: " +
    `${topics.map((t) => `"${t}"`).join(", ")}. ` +
    'Respond ONLY with strict JSON: {"score": <number 0..1 confidence the text IS about a restricted topic>, ' +
    '"topic": <the matched restricted topic, or "">, "reasoning": <string>}.'
  );
}

function parseModelJudge(text: string): { score: number; topic?: string; reasoning: string } {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text);
    const score = Math.max(0, Math.min(1, Number(parsed.score)));
    return {
      score: Number.isFinite(score) ? score : 0,
      topic: typeof parsed.topic === "string" ? parsed.topic : undefined,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return { score: 0, reasoning: text.slice(0, 500) };
  }
}

async function runOneModelGuard(
  projectId: string,
  policy: GuardrailPolicy,
  prompt: string,
  text: string,
): Promise<{ score: number; topic?: string; reasoning: string }> {
  // The mock provider can't classify — treat as safe (score 0) so it never spuriously blocks,
  // and skip the model call entirely (the default judge in dev/tests).
  if (policy.judgeProvider === "mock") return { score: 0, reasoning: "mock" };
  const config = await resolveProviderConfig(projectId, policy.judgeProvider as Provider);
  const result = await generate({
    provider: policy.judgeProvider as Provider,
    model: policy.judgeModel,
    ...config,
    temperature: 0,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  });
  return parseModelJudge(result.content);
}

/**
 * Built-in model guards for the two categories the deterministic scan can't cover:
 * restricted TOPICS and TOXICITY. LLM-backed and FAIL-OPEN (a timeout/error/missing key
 * produces no finding), the same house rule as `runEvaluatorGuards`. A finding here always
 * blocks — these are safety violations, not soft quality signals. Returns [] when neither is
 * enabled. Seam note: this is the in-process GuardrailProvider for topic/toxicity; a Presidio
 * (or cloud-DLP) adapter could replace `runOneModelGuard` without changing call sites.
 */
export async function runModelGuards(
  projectId: string,
  text: string,
  policy: GuardrailPolicy,
): Promise<GuardrailFinding[]> {
  const checks: { kind: "topic" | "toxicity"; prompt: string }[] = [];
  if (policy.restrictedTopics.length > 0)
    checks.push({ kind: "topic", prompt: topicJudgePrompt(policy.restrictedTopics) });
  if (policy.toxicity) checks.push({ kind: "toxicity", prompt: TOXICITY_JUDGE_PROMPT });
  if (checks.length === 0) return [];

  const settled = await Promise.allSettled(
    checks.map((c) => withTimeout(runOneModelGuard(projectId, policy, c.prompt, text), GUARD_TIMEOUT_MS)),
  );
  const findings: GuardrailFinding[] = [];
  settled.forEach((result, i) => {
    const c = checks[i] as { kind: "topic" | "toxicity"; prompt: string };
    if (result.status !== "fulfilled") {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(JSON.stringify({ scope: "guardrails.modelGuard", projectId, kind: c.kind, error }));
      return; // fail-open
    }
    const { score, topic } = result.value;
    if (c.kind === "toxicity") {
      if (score >= policy.toxicityThreshold) findings.push({ category: "toxicity", type: "toxic", count: 1, score });
    } else if (score >= 0.5) {
      // topic: block when the classifier is confident the text is about a restricted topic.
      findings.push({ category: "topic", type: topic || "restricted_topic", count: 1, score });
    }
  });
  return findings;
}

/**
 * The orchestrator the /check endpoint calls: local `scanGuardrails` first (cheap,
 * deterministic), then — only if the local scan hasn't already blocked and the policy has
 * evaluator guards configured — the opt-in LLM-judge guards. This short-circuit avoids
 * paying for an LLM call when a regex already settled the verdict.
 */
export async function checkGuardrails(projectId: string, text: string): Promise<GuardrailResult> {
  const policy = await loadGuardrailPolicy(projectId);
  if (!policy) return { verdict: "allow", findings: [] };

  const local = scanGuardrails(text, policy);
  // A hard deterministic block short-circuits the (paid, slower) LLM guards entirely.
  if (local.verdict === "block") return local;

  const needEval = policy.evaluatorGuards.length > 0;
  const needModel = policy.toxicity || policy.restrictedTopics.length > 0;
  if (!needEval && !needModel) return local;

  const [evalFindings, modelFindings] = await Promise.all([
    needEval ? runEvaluatorGuards(projectId, text, policy.evaluatorGuards) : Promise.resolve<GuardrailFinding[]>([]),
    needModel ? runModelGuards(projectId, text, policy) : Promise.resolve<GuardrailFinding[]>([]),
  ]);
  const extra = [...evalFindings, ...modelFindings];
  if (extra.length === 0) return local;

  // Topic/toxicity are safety violations → always block. Evaluator guards keep prior behavior
  // (they don't upgrade a PII redact to a block).
  const verdict: GuardrailVerdict =
    modelFindings.length > 0 ? "block" : local.verdict === "redact" ? "redact" : "block";
  return {
    verdict,
    findings: [...local.findings, ...extra],
    ...(local.redactedText !== undefined ? { redactedText: local.redactedText } : {}),
  };
}

// Unconfigured projects scan with everything on, so the endpoint is useful out of the box.
// Evaluator guards stay off by default even here — they're opt-in per-project config, not a
// blanket default (there's no evaluator to run against until the project creates one).
const SCAN_DEFAULT: GuardrailPolicy = {
  enabled: true,
  pii: true,
  piiAction: "redact",
  builtins: BUILTIN_NAMES,
  customPatterns: [],
  redactWith: "[REDACTED]",
  injection: true,
  blockedTerms: [],
  sqlInjection: false,
  requireMatch: [],
  requireValidJson: false,
  requiredJsonKeys: [],
  evaluatorGuards: [],
  // Model guards stay off by default — they need a judge model + a topics list to be useful.
  restrictedTopics: [],
  toxicity: false,
  toxicityThreshold: 0.5,
  judgeProvider: "mock",
  judgeModel: "mock-1",
};

// The starter config shown in the console when nothing is saved yet (disabled by default).
const CONFIG_DEFAULT: GuardrailPolicy = { ...SCAN_DEFAULT, enabled: false };

export async function getGuardrailPolicy(projectId: string): Promise<GuardrailPolicy & { available: string[] }> {
  const p = await prisma.guardrailPolicy.findUnique({ where: { projectId } });
  const policy: GuardrailPolicy = p ? toPolicy(p) : CONFIG_DEFAULT;
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
  sqlInjection?: boolean;
  requireMatch?: string[];
  requireValidJson?: boolean;
  requiredJsonKeys?: string[];
  evaluatorGuards?: EvaluatorGuard[];
  restrictedTopics?: string[];
  toxicity?: boolean;
  toxicityThreshold?: number;
  judgeProvider?: string;
  judgeModel?: string;
}

const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;

/**
 * Drop guards whose evaluator name doesn't exist for the project (a guard pointing at a
 * deleted/renamed evaluator would otherwise silently fail-open forever), and clamp
 * comparator/threshold to their valid ranges. Mirrors the defensive filtering
 * setGuardrailPolicy already does for builtins/blockedTerms.
 */
async function validateEvaluatorGuards(projectId: string, guards: EvaluatorGuard[]): Promise<EvaluatorGuard[]> {
  if (guards.length === 0) return [];
  const known = new Set((await listEvaluators(projectId)).map((e) => e.name));
  return guards
    .filter((g) => g && typeof g.name === "string" && known.has(g.name))
    .map((g) => {
      const threshold = Number(g.threshold);
      return {
        name: g.name,
        // Default to "lt" (quality-floor: block when below threshold) for malformed input.
        comparator: (COMPARATORS as readonly string[]).includes(g.comparator) ? g.comparator : "lt",
        threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0,
      };
    });
}

export async function setGuardrailPolicy(projectId: string, input: SetGuardrailInput) {
  const customPatterns = input.customPatterns ?? [];
  const requireMatch = (input.requireMatch ?? []).map((s) => s.trim()).filter(Boolean);
  // customPatterns and requireMatch are both compiled as regex in scanGuardrails and run on the
  // shared worker — validate them (invalid syntax / ReDoS / count) before persisting. blockedTerms
  // are regex-escaped at scan time, so they don't need pattern validation.
  assertSafeUserPatterns([...customPatterns, ...requireMatch]);
  const data = {
    enabled: input.enabled ?? false,
    pii: input.pii ?? true,
    piiAction: input.piiAction === "block" ? "block" : "redact",
    builtins: (input.builtins ?? []).filter((b) => BUILTIN_NAMES.includes(b)),
    customPatterns,
    redactWith: input.redactWith || "[REDACTED]",
    injection: input.injection ?? true,
    blockedTerms: (input.blockedTerms ?? []).map((t) => t.trim()).filter(Boolean),
    sqlInjection: input.sqlInjection ?? false,
    requireMatch,
    requireValidJson: input.requireValidJson ?? false,
    requiredJsonKeys: (input.requiredJsonKeys ?? []).map((k) => k.trim()).filter(Boolean),
    evaluatorGuards: (await validateEvaluatorGuards(projectId, input.evaluatorGuards ?? [])) as object,
    restrictedTopics: (input.restrictedTopics ?? []).map((t) => t.trim()).filter(Boolean),
    toxicity: input.toxicity ?? false,
    toxicityThreshold: clamp01(input.toxicityThreshold ?? 0.5),
    judgeProvider: (input.judgeProvider ?? "mock").trim() || "mock",
    judgeModel: (input.judgeModel ?? "mock-1").trim() || "mock-1",
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
  sqlInjection: boolean;
  requireMatch: string[];
  requireValidJson: boolean;
  requiredJsonKeys: string[];
  evaluatorGuards: unknown;
  restrictedTopics: string[];
  toxicity: boolean;
  toxicityThreshold: number;
  judgeProvider: string;
  judgeModel: string;
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
    sqlInjection: p.sqlInjection,
    requireMatch: p.requireMatch,
    requireValidJson: p.requireValidJson,
    requiredJsonKeys: p.requiredJsonKeys,
    evaluatorGuards: Array.isArray(p.evaluatorGuards) ? (p.evaluatorGuards as EvaluatorGuard[]) : [],
    restrictedTopics: p.restrictedTopics,
    toxicity: p.toxicity,
    toxicityThreshold: p.toxicityThreshold,
    judgeProvider: p.judgeProvider,
    judgeModel: p.judgeModel,
  };
}

async function bustCache(projectId: string) {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}
