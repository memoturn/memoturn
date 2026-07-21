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

/** Cap on user-supplied regex patterns per policy (masking custom + guardrail custom/requireMatch). */
export const MAX_USER_PATTERNS = 50;

/** Raised when a user-supplied regex is rejected at policy-write time. Surfaced as a 400. */
export class UserPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserPatternError";
  }
}

function isValidRegex(src: string): boolean {
  try {
    return Boolean(new RegExp(src, "g"));
  } catch {
    return false;
  }
}

/**
 * Maximum regex "star height": the deepest nesting of repetition operators (`*`, `+`, `{n,}`).
 * A height ≥ 2 — a repeated group that itself repeats, e.g. `(a+)+` or `([a-z]*)*` — is the
 * structural signature of catastrophic backtracking (ReDoS). This is computed by walking the
 * pattern STATICALLY (no execution), so it is deterministic and portable — unlike timing a probe
 * input, which varies with CPU speed and, on a pathological pattern, can itself hang the caller.
 * Conservative by design: it may reject an unusual-but-safe nested-repeat pattern, which is an
 * acceptable trade for a PII-redaction config that runs on every event in the shared worker.
 */
export function maxStarHeight(src: string): number {
  let i = 0;

  const walk = (): number => {
    let groupMax = 0;
    let lastHeight = 0; // star height of the most recent atom at this level
    let haveAtom = false;
    const bump = (h: number) => {
      if (h > groupMax) groupMax = h;
    };
    const flushAtom = () => {
      if (haveAtom) bump(lastHeight);
    };

    while (i < src.length) {
      const c = src[i];
      if (c === ")") break; // let the caller consume the ')'
      if (c === "|") {
        flushAtom();
        lastHeight = 0;
        haveAtom = false;
        i++;
      } else if (c === "\\") {
        flushAtom();
        lastHeight = 0;
        haveAtom = true;
        i += 2; // escaped atom
      } else if (c === "[") {
        flushAtom();
        i++;
        while (i < src.length && src[i] !== "]") {
          if (src[i] === "\\") i++;
          i++;
        }
        i++; // closing ]
        lastHeight = 0;
        haveAtom = true;
      } else if (c === "(") {
        flushAtom();
        i++;
        // Skip a group-type prefix so its punctuation isn't misread as a quantifier.
        if (src[i] === "?") {
          i++;
          if (src[i] === "<" && (src[i + 1] === "=" || src[i + 1] === "!"))
            i += 2; // lookbehind
          else if (src[i] === "<") {
            while (i < src.length && src[i] !== ">") i++;
            if (src[i] === ">") i++; // named group
          } else if (src[i] === ":" || src[i] === "=" || src[i] === "!") i++;
        }
        lastHeight = walk();
        if (src[i] === ")") i++;
        haveAtom = true;
      } else if (c === "*" || c === "+") {
        if (haveAtom) bump((lastHeight += 1));
        i++;
      } else if (c === "{") {
        const close = src.indexOf("}", i);
        if (close === -1) {
          flushAtom(); // a literal '{'
          lastHeight = 0;
          haveAtom = true;
          i++;
        } else {
          const repeating = src.slice(i + 1, close).includes(","); // {n,}/{n,m} repeat; {n} is exact
          i = close + 1;
          if (haveAtom && repeating) bump((lastHeight += 1));
        }
      } else if (c === "?") {
        i++; // optional / lazy suffix — adds no star height
      } else {
        flushAtom(); // ordinary literal
        lastHeight = 0;
        haveAtom = true;
        i++;
      }
    }
    flushAtom();
    return groupMax;
  };

  return walk();
}

/**
 * Validate user-supplied regex sources at policy-WRITE time: reject invalid syntax, too many
 * patterns, or a pattern with nested repetition (ReDoS risk). This keeps pathological regexes out
 * of the shared ingest worker, where masking runs synchronously over every event — a ReDoS pattern
 * there would wedge ingest for every tenant on the replica (a low-privilege, cross-tenant DoS).
 * Throws UserPatternError (→ 400). Callers pass every user regex the policy will execute.
 */
export function assertSafeUserPatterns(patterns: string[]): void {
  if (patterns.length > MAX_USER_PATTERNS) {
    throw new UserPatternError(`too many custom patterns (max ${MAX_USER_PATTERNS})`);
  }
  for (const src of patterns) {
    if (!isValidRegex(src)) {
      throw new UserPatternError(`invalid regex: ${src.slice(0, 80)}`);
    }
    if (maxStarHeight(src) >= 2) {
      throw new UserPatternError(
        `pattern rejected — nested repetition risks catastrophic backtracking: ${src.slice(0, 80)}`,
      );
    }
  }
}

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
    // Runtime backstop: honor the count cap even for rows written before validation existed.
    ...policy.customPatterns.slice(0, MAX_USER_PATTERNS),
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
  const customPatterns = input.customPatterns ?? [];
  assertSafeUserPatterns(customPatterns); // reject invalid / ReDoS patterns before they reach ingest
  const data = {
    enabled: input.enabled ?? false,
    builtins: (input.builtins ?? []).filter((b) => BUILTIN_NAMES.includes(b)),
    customPatterns,
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
