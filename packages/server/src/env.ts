/**
 * Startup environment validation. memoturn is self-hosted, so the biggest production
 * risk is a deploy that silently falls back to a development default for a security-
 * critical secret (forgeable sessions, provider keys encrypted with a public key).
 *
 * `validateRuntimeEnv` is called once at API and worker boot: in production it THROWS
 * (refusing to start) when a required secret is missing/weak; in development it warns
 * once so the dev defaults remain ergonomic. Keep this dependency-free.
 */
const MIN_SECRET_LEN = 16;

/** Known development placeholders that must never be used in production. */
const WEAK_VALUES = new Set([
  "dev-only-change-me",
  "dev-secret-please-change-in-prod-0123456789",
  "dev-encryption-key-please-change-in-prod-0123456789",
  "memoturn-dev-encryption-key",
  "changeme",
  "secret",
]);

/**
 * Every placeholder shipped in `.env.example` shares this marker; matching it catches the
 * ENCRYPTION_KEY/BETTER_AUTH_SECRET examples (and any future one) even if the exact string
 * drifts, so a self-hoster can't boot production with a world-readable committed secret.
 */
const PLACEHOLDER_MARKER = "please-change-in-prod";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

// ── Typed environment schema ─────────────────────────────────────────────────────
// Every knob the API/worker read is declared here with its shape, so a typo'd value
// (`WORKER_CONCURRENCY=ten`, `RATE_LIMIT_PER_MINUTE=1,000`) fails at boot with a clear
// message instead of silently becoming NaN somewhere deep in a queue or rate-limit call.
// Hand-rolled on purpose: this module must stay dependency-free (it runs before anything
// else and is imported by every entrypoint).
type EnvSpec =
  | { kind: "int"; min?: number; max?: number }
  | { kind: "bool" }
  | { kind: "url"; protocols: readonly string[] }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; minLength?: number };

type Service = "api" | "worker";

interface EnvVar {
  spec: EnvSpec;
  /** Required (non-empty) in production for these services. */
  requiredIn?: readonly Service[];
  /** Explain why the default is unsafe when the var is missing in production. */
  why?: string;
}

const int = (min = 0, max?: number): EnvSpec => ({ kind: "int", min, max });
const url = (...protocols: string[]): EnvSpec => ({ kind: "url", protocols });
const BOTH: readonly Service[] = ["api", "worker"];

export const ENV_SCHEMA: Record<string, EnvVar> = {
  // Datastores — every one of these has a localhost/dev-credential fallback in code, which is
  // exactly what must never be reached in production.
  DATABASE_URL: { spec: url("postgresql:", "postgres:"), requiredIn: BOTH },
  REDIS_URL: { spec: url("redis:", "rediss:"), requiredIn: BOTH, why: "the fallback is localhost:6379" },
  BLOB_ENDPOINT: { spec: url("http:", "https:"), requiredIn: BOTH, why: "the fallback is a local MinIO" },
  BLOB_ACCESS_KEY_ID: { spec: { kind: "string" }, requiredIn: BOTH, why: "the fallback is a public dev credential" },
  BLOB_SECRET_ACCESS_KEY: {
    spec: { kind: "string" },
    requiredIn: BOTH,
    why: "the fallback is a public dev credential",
  },
  BLOB_BUCKET: { spec: { kind: "string" } },
  BLOB_REGION: { spec: { kind: "string" } },
  BLOB_FORCE_PATH_STYLE: { spec: { kind: "bool" } },
  TELEMETRY_ENGINE: { spec: { kind: "enum", values: ["doris", "postgres", "pg"] } },
  TELEMETRY_DATABASE_URL: { spec: url("postgresql:", "postgres:") },
  DORIS_HOST: { spec: { kind: "string" } }, // required-in-prod only on the Doris engine (checked below)
  DORIS_PORT: { spec: int(1, 65535) },
  DORIS_HTTP_PORT: { spec: int(1, 65535) },
  DORIS_STREAM_LOAD_PORT: { spec: int(1, 65535) },
  DORIS_STREAM_LOAD_TIMEOUT_MS: { spec: int(1000) },
  DORIS_POOL_SIZE: { spec: int(1, 1000) },
  DORIS_CONNECT_TIMEOUT_MS: { spec: int(100) },
  DORIS_QUERY_TIMEOUT_S: { spec: int(1) },
  TELEMETRY_STREAM_LOAD: { spec: { kind: "bool" } },
  TELEMETRY_PG_POOL_SIZE: { spec: int(1, 1000) },
  TELEMETRY_PG_STATEMENT_TIMEOUT_MS: { spec: int(100) },
  PRISMA_POOL_SIZE: { spec: int(1, 1000) },
  PRISMA_TRANSACTION_TIMEOUT_MS: { spec: int(100) },
  PRISMA_TRANSACTION_MAX_WAIT_MS: { spec: int(100) },
  // API
  API_PORT: { spec: int(1, 65535) },
  API_REQUEST_TIMEOUT_MS: { spec: int(1000) },
  SSE_MAX_STREAMS_PER_PROJECT: { spec: int(0) },
  RATE_LIMIT_PER_MINUTE: { spec: int(0) },
  INGEST_EVENTS_PER_MINUTE: { spec: int(0) },
  INGEST_MAX_EVENT_BYTES: { spec: int(1024) },
  INGEST_MAX_JSON_DEPTH: { spec: int(4, 512) },
  RATE_LIMIT_TRUSTED_PROXIES: { spec: int(0, 16) },
  MCP_RATE_LIMIT_PER_MINUTE: { spec: int(0) },
  PLAYGROUND_MAX_TOKENS: { spec: int(1) },
  LLM_TIMEOUT_MS: { spec: int(1000) },
  LLM_STREAM_TIMEOUT_MS: { spec: int(1000) },
  GUARDRAIL_EVALUATOR_TIMEOUT_MS: { spec: int(100) },
  LOG_LEVEL: { spec: { kind: "enum", values: ["debug", "info", "warn", "error"] } },
  // Worker
  WORKER_PORT: { spec: int(1, 65535) },
  WORKER_CONCURRENCY: { spec: int(1, 1000) },
  EXPERIMENT_CONCURRENCY: { spec: int(1, 100) },
  EXPERIMENT_ITEM_CONCURRENCY: { spec: int(1, 100) },
  EVAL_BACKFILL_CONCURRENCY: { spec: int(1, 100) },
  MAINTENANCE_CONCURRENCY: { spec: int(1, 100) },
  SANDBOX_CONCURRENCY: { spec: int(1, 100) },
  WORKER_SHUTDOWN_TIMEOUT_MS: { spec: int(1000) },
  STATE_RETENTION_HOURS: { spec: int(1) },
  TELEMETRY_MAX_RETENTION_DAYS: { spec: int(0) },
  DLQ_ALERT_DEPTH: { spec: int(0) },
  // Auth
  AUTH_BASE_URL: {
    spec: url("http:", "https:"),
    requiredIn: BOTH,
    why: "emails and OAuth callbacks are built from it",
  },
  AUTH_MIN_PASSWORD_LENGTH: { spec: int(8, 256) },
  AUTH_ORG_MEMBERSHIP_LIMIT: { spec: int(1) },
  AUTH_ORG_INVITATION_LIMIT: { spec: int(1) },
  AUTH_COOKIE_CACHE_MAX_AGE: { spec: int(0) },
  AUTH_REQUIRE_EMAIL_VERIFICATION: { spec: { kind: "bool" } },
  AUTH_DISABLE_PASSWORD_SIGNUP: { spec: { kind: "bool" } },
  AUTH_HIBP_DISABLED: { spec: { kind: "bool" } },
  AUTH_COOKIE_CACHE_DISABLED: { spec: { kind: "bool" } },
  AUTH_SIGNIN_MAX_PER_15M: { spec: int(1) },
  AUTH_OAUTH_REGISTER_MAX_PER_HOUR: { spec: int(1) },
  API_KEY_DEFAULT_EXPIRY_DAYS: { spec: int(1) },
  API_DOCS_PUBLIC: { spec: { kind: "bool" } },
  // Demo
  DEMO_MODE: { spec: { kind: "bool" } },
  DEMO_TTL_DAYS: { spec: int(1) },
  DEMO_MAX_SANDBOXES: { spec: int(1) },
  DEMO_SEED_DAYS: { spec: int(1) },
  DEMO_SEED_TRACES_PER_DAY: { spec: int(1) },
  DEMO_FINALIZE_DELAY_MS: { spec: int(0) },
  DEMO_START_RATE_LIMIT_PER_MINUTE: { spec: int(0) },
};

function checkSpec(name: string, raw: string, spec: EnvSpec): string | null {
  switch (spec.kind) {
    case "int": {
      if (!/^-?\d+$/.test(raw.trim())) return `${name}=${JSON.stringify(raw)} is not an integer`;
      const n = Number(raw);
      if (spec.min !== undefined && n < spec.min) return `${name}=${raw} is below the minimum ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `${name}=${raw} is above the maximum ${spec.max}`;
      return null;
    }
    case "bool":
      return /^(1|0|true|false)$/i.test(raw.trim()) ? null : `${name}=${JSON.stringify(raw)} must be 1/0/true/false`;
    case "url": {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return `${name} is not a valid URL`;
      }
      return spec.protocols.includes(u.protocol) ? null : `${name} must use ${spec.protocols.join(" or ")}`;
    }
    case "enum":
      return spec.values.includes(raw.trim().toLowerCase())
        ? null
        : `${name}=${JSON.stringify(raw)} must be one of ${spec.values.join(", ")}`;
    case "string":
      return spec.minLength !== undefined && raw.length < spec.minLength
        ? `${name} must be at least ${spec.minLength} characters`
        : null;
  }
}

/**
 * Validate every declared variable that is set (shape/range) and, in production, every one
 * that is required for `service`. Returns human-readable problems; empty = fine.
 */
export function envSchemaProblems(service: Service, production = isProduction()): string[] {
  const problems: string[] = [];
  const engine = (process.env.TELEMETRY_ENGINE ?? "doris").toLowerCase();
  for (const [name, def] of Object.entries(ENV_SCHEMA)) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
      if (production && def.requiredIn?.includes(service)) {
        problems.push(`${name} must be set in production${def.why ? ` — ${def.why}` : ""}`);
      }
      continue;
    }
    const p = checkSpec(name, raw, def.spec);
    if (p) problems.push(p);
  }
  if (production && engine !== "postgres" && engine !== "pg" && !process.env.DORIS_HOST) {
    problems.push("DORIS_HOST must be set in production on the Doris engine (or set TELEMETRY_ENGINE=postgres)");
  }
  return problems;
}

/** Read an integer knob with a fallback — malformed values fall back rather than becoming NaN. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * True when AUTH_BASE_URL points at a public https origin — the strongest available signal
 * that this process is a real deployment. Used to catch a forgotten NODE_ENV=production,
 * because every production-only protection (secret guard, Secure cookies, dev fallbacks)
 * keys on NODE_ENV and would silently stay off.
 */
export function looksDeployed(): boolean {
  const raw = process.env.AUTH_BASE_URL;
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function secretProblem(name: string): string | null {
  const v = process.env[name];
  if (!v || v.length < MIN_SECRET_LEN) {
    return `${name} must be set to at least ${MIN_SECRET_LEN} characters`;
  }
  if (WEAK_VALUES.has(v) || v.includes(PLACEHOLDER_MARKER)) {
    return `${name} is set to a known development placeholder — generate a fresh random value`;
  }
  return null;
}

/**
 * Validate the environment for a given service ("api" | "worker"). Throws in production
 * when configuration is insecure; warns in development. Call once at process boot.
 */
export function validateRuntimeEnv(service: Service): void {
  const required = ["ENCRYPTION_KEY", "BETTER_AUTH_SECRET"];

  if (!isProduction() && looksDeployed()) {
    throw new Error(
      `[${service}] refusing to start — AUTH_BASE_URL is a public https origin (${process.env.AUTH_BASE_URL}) ` +
        "but NODE_ENV is not 'production'. Every production protection (secret guard, Secure cookies, no dev " +
        "fallbacks) keys on NODE_ENV=production — set it.",
    );
  }

  if (isProduction()) {
    const problems: string[] = [];
    for (const name of required) {
      const p = secretProblem(name);
      if (p) problems.push(p);
    }
    problems.push(...envSchemaProblems(service, true));
    if (!process.env.AUTH_TRUSTED_ORIGINS) {
      problems.push("AUTH_TRUSTED_ORIGINS must be set to your console origin(s) in production");
    }
    // The dev `.env.example` ships ALLOW_PRIVATE_WEBHOOK_TARGETS=1 (webhooks to localhost are
    // a normal dev need). `prod:up` reads `.env`, so an operator who copied the dev file and
    // only replaced the secrets would silently ship an SSRF-open install — refuse unless they
    // acknowledge it explicitly.
    if (
      isTruthy(process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS) &&
      !isTruthy(process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK)
    ) {
      problems.push(
        "ALLOW_PRIVATE_WEBHOOK_TARGETS=1 lets project admins point webhooks at private/loopback " +
          "addresses (cloud metadata, internal services). Unset it, or set " +
          "ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK=1 if your deployment genuinely needs LAN targets",
      );
    }
    // Test-suite knob; there is no production reason to turn off auth brute-force protection.
    if (isTruthy(process.env.AUTH_RATE_LIMIT_DISABLED)) {
      problems.push("AUTH_RATE_LIMIT_DISABLED is a test-only switch — never set it in production");
    }
    if (problems.length > 0) {
      throw new Error(
        `[${service}] refusing to start — insecure production configuration:\n  - ${problems.join("\n  - ")}\n` +
          "Generate secrets with e.g. `openssl rand -base64 48` and set them in the environment.",
      );
    }
    // Non-fatal: API rate limiting defaults to disabled. Warn (don't throw — some deployments
    // rate-limit at the edge) so an unthrottled ingest/read surface isn't a silent posture.
    if (
      service === "api" &&
      process.env.RATE_LIMIT_PER_MINUTE !== undefined &&
      Number(process.env.RATE_LIMIT_PER_MINUTE) === 0
    ) {
      console.warn(
        `[${service}] RATE_LIMIT_PER_MINUTE=0 — the API is unthrottled. Remove the override (default 600) ` +
          "or ensure an upstream proxy enforces limits in production.",
      );
    }
    // DEMO_MODE exposes an UNAUTHENTICATED provisioning endpoint (POST /v1/demo/start creates
    // orgs/projects/users and seeds telemetry). It's one env var away on every install, so
    // announce it at boot where an operator reviewing logs will see it.
    if (isTruthy(process.env.DEMO_MODE)) {
      console.warn(
        `[${service}] DEMO_MODE is ON — this deployment is a PUBLIC DEMO: anyone with an email address ` +
          "can provision a read-only sandbox via POST /v1/demo/start. Unset DEMO_MODE for a normal install.",
      );
    }
    return;
  }

  // Development: keep dev defaults ergonomic but make the fallback visible once.
  for (const name of required) {
    if (!process.env[name]) {
      console.warn(
        `[${service}] ${name} is not set — using an insecure development default. Do NOT use this in production.`,
      );
    }
  }
  // Malformed knobs are still worth a warning in dev — they'd silently become NaN otherwise.
  for (const p of envSchemaProblems(service, false)) console.warn(`[${service}] env: ${p}`);
}

/**
 * The Better Auth signing secret. In production it is mandatory (the boot guard already
 * enforces this for the API and worker); this point-of-use check covers every OTHER
 * process that imports the auth config — the migrate container, scripts, a future CLI —
 * so none of them can ever sign a session with the public development fallback.
 */
export function authSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  if (isProduction()) throw new Error("BETTER_AUTH_SECRET is required in production");
  return "dev-only-change-me";
}

/**
 * The console's public origin — where a human clicks through to.
 *
 * Single source of truth, because getting this wrong puts a dead link in someone's inbox.
 * Resolution order:
 *   1. `CONSOLE_PUBLIC_URL` — explicit, wins when set.
 *   2. The first entry of `AUTH_TRUSTED_ORIGINS` — already the console origin by definition
 *      (it's what CORS and every auth bounce-back use), and set in every production deploy.
 *
 * Deliberately NOT `AUTH_BASE_URL`: that is the *API* origin (`:3001` in dev). They coincide
 * on the single-VM stack, where Caddy serves the console at the root, but they are different
 * things and using it as a fallback emits an API URL in emails on any split deployment.
 */
export function consoleOrigin(): string {
  const explicit = process.env.CONSOLE_PUBLIC_URL?.trim();
  const trusted = process.env.AUTH_TRUSTED_ORIGINS?.split(",")[0]?.trim();
  return (explicit || trusted || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The console origin when it's reachable by whoever receives it, else null.
 *
 * A localhost URL is correct for a browser on the dev machine but meaningless in an inbox,
 * so email templates use this and omit the link rather than shipping a dead one.
 */
export function publicConsoleOrigin(): string | null {
  const origin = consoleOrigin();
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(origin) ? null : origin;
}
