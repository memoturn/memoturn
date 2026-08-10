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
export function validateRuntimeEnv(service: string): void {
  const required = ["ENCRYPTION_KEY", "BETTER_AUTH_SECRET"];

  if (isProduction()) {
    const problems: string[] = [];
    for (const name of required) {
      const p = secretProblem(name);
      if (p) problems.push(p);
    }
    if (!process.env.AUTH_TRUSTED_ORIGINS) {
      problems.push("AUTH_TRUSTED_ORIGINS must be set to your console origin(s) in production");
    }
    if (problems.length > 0) {
      throw new Error(
        `[${service}] refusing to start — insecure production configuration:\n  - ${problems.join("\n  - ")}\n` +
          "Generate secrets with e.g. `openssl rand -base64 48` and set them in the environment.",
      );
    }
    // Non-fatal: API rate limiting defaults to disabled. Warn (don't throw — some deployments
    // rate-limit at the edge) so an unthrottled ingest/read surface isn't a silent posture.
    if (service === "api" && !(Number(process.env.RATE_LIMIT_PER_MINUTE) > 0)) {
      console.warn(
        `[${service}] RATE_LIMIT_PER_MINUTE is unset/0 — the API is unthrottled. Set it (and ` +
          "INGEST_EVENTS_PER_MINUTE) or ensure an upstream proxy enforces limits in production.",
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
