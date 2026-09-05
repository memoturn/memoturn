/**
 * Errors whose message is SAFE to show to an API client. Everything else that reaches a
 * handler's catch is an internal failure: provider SDK internals, driver messages, file
 * paths, hostnames — logged server-side, never echoed (see `publicErrorMessage`).
 */
export class PublicError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 402 | 403 | 404 | 409 | 422 | 429 = 400,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

/** A project's hard cost cap is exhausted for the month — LLM-backed features refuse to spend. */
export class BudgetExceededError extends PublicError {
  constructor(
    public readonly spentUsd: number,
    public readonly monthlyUsd: number,
  ) {
    super(
      `monthly cost budget exhausted ($${spentUsd.toFixed(2)} of $${monthlyUsd.toFixed(2)}) — raise the budget or ` +
        "disable the hard cap in Settings → Alerts",
      402,
    );
    this.name = "BudgetExceededError";
  }
}

// Anything that smells like an internal detail: drivers, hosts, paths, stack frames.
const INTERNAL_RE =
  /ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|prisma|postgres|mysql|doris|redis|bullmq|\/(Users|home|app|tmp)\/|\bat\s+\S+:\d+:\d+|node_modules|invalid input syntax|relation "|column "|syntax error/i;

/**
 * The message to put in an error response. Provider/user-facing messages ("invalid API key",
 * "dataset not found") pass through, bounded; anything that looks internal is replaced by a
 * generic message. Callers still log the real error.
 */
export function publicErrorMessage(err: unknown, fallback = "request failed"): string {
  if (err instanceof PublicError) return err.message;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw || INTERNAL_RE.test(raw)) return fallback;
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}
