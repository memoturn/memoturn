import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * PII masking: redact sensitive substrings from trace/observation input/output at
 * ingest (worker), before the telemetry store. Built-in named patterns + custom regexes are
 * compiled once per batch; the policy is Redis-cached. The compile/apply helpers are
 * pure so they're unit-testable without infra.
 */
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string) => `memoturn:masking:${projectId}`;

// High-confidence built-in patterns. Lower-confidence cases (API keys, names) are left
// to custom regexes to avoid over-redacting normal content.
export const BUILTIN_PATTERNS: Record<string, string> = {
  email: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+",
  credit_card: "\\b(?:\\d[ -]?){13,16}\\b",
  ssn: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
  ipv4: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
};
export const BUILTIN_NAMES = Object.keys(BUILTIN_PATTERNS);

export interface MaskingPolicy {
  enabled: boolean;
  builtins: string[];
  customPatterns: string[];
  redactWith: string;
}

export interface Maskers {
  regexes: RegExp[];
  redactWith: string;
}

/** Compile a policy's built-in + custom patterns into global RegExps (bad regexes dropped). */
export function compileMaskers(policy: MaskingPolicy): Maskers {
  const sources = [
    ...policy.builtins.map((b) => BUILTIN_PATTERNS[b]).filter((s): s is string => Boolean(s)),
    ...policy.customPatterns,
  ];
  const regexes: RegExp[] = [];
  for (const src of sources) {
    try {
      regexes.push(new RegExp(src, "g"));
    } catch {
      // skip invalid custom patterns
    }
  }
  return { regexes, redactWith: policy.redactWith };
}

/** Deep-walk a JSON value, replacing every regex match in string leaves with redactWith. */
export function applyMasking(value: unknown, maskers: Maskers): unknown {
  if (maskers.regexes.length === 0) return value;
  if (typeof value === "string") {
    let out = value;
    for (const re of maskers.regexes) out = out.replace(re, maskers.redactWith);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => applyMasking(v, maskers));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyMasking(v, maskers);
    return out;
  }
  return value;
}

const DEFAULT: MaskingPolicy = { enabled: false, builtins: [], customPatterns: [], redactWith: "[REDACTED]" };

export async function getMaskingPolicy(projectId: string): Promise<MaskingPolicy & { available: string[] }> {
  const p = await prisma.maskingPolicy.findUnique({ where: { projectId } });
  const policy = p
    ? { enabled: p.enabled, builtins: p.builtins, customPatterns: p.customPatterns, redactWith: p.redactWith }
    : DEFAULT;
  return { ...policy, available: BUILTIN_NAMES };
}

export interface SetMaskingInput {
  enabled?: boolean;
  builtins?: string[];
  customPatterns?: string[];
  redactWith?: string;
}

export async function setMaskingPolicy(projectId: string, input: SetMaskingInput) {
  const data = {
    enabled: input.enabled ?? false,
    builtins: (input.builtins ?? []).filter((b) => BUILTIN_NAMES.includes(b)),
    customPatterns: input.customPatterns ?? [],
    redactWith: input.redactWith || "[REDACTED]",
  };
  const p = await prisma.maskingPolicy.upsert({ where: { projectId }, update: data, create: { projectId, ...data } });
  await bustCache(projectId);
  return {
    enabled: p.enabled,
    builtins: p.builtins,
    customPatterns: p.customPatterns,
    redactWith: p.redactWith,
    available: BUILTIN_NAMES,
  };
}

/** Load a project's policy for the worker (Redis-cached, best-effort). */
export async function loadMaskingPolicy(projectId: string): Promise<MaskingPolicy> {
  try {
    const raw = await redisConnection().get(cacheKey(projectId));
    if (raw) return JSON.parse(raw) as MaskingPolicy;
  } catch {
    // fall through to DB
  }
  const { available: _available, ...policy } = await getMaskingPolicy(projectId);
  try {
    await redisConnection().set(cacheKey(projectId), JSON.stringify(policy), "EX", CACHE_TTL_SECONDS);
  } catch {
    // best-effort
  }
  return policy;
}

async function bustCache(projectId: string) {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}
