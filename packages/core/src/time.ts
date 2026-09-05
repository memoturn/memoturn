/**
 * Time-column guards shared by the worker (event mapper) and the server (state mirror).
 *
 * On Doris, a trace's `timestamp`, an observation's `start_time`, and a score's `timestamp`
 * are PART OF THE UNIQUE KEY because they partition the tables. Two rules keep the logical
 * identity (project_id, id) intact:
 *  1. First value wins for the life of the entity (enforced in the state upsert), and
 *  2. A value more than a day in the future (clock skew, a bad SDK) is clamped so it can't
 *     mint a junk partition years ahead.
 */
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** ISO string clamped to now + 1 day; non-dates pass through (zod already rejected them upstream). */
export function clampFuture(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= nowMs + FUTURE_SKEW_MS) return iso;
  return new Date(nowMs + FUTURE_SKEW_MS).toISOString();
}

/** Same clamp for Date values. */
export function clampFutureDate(d: Date, nowMs = Date.now()): Date {
  return d.getTime() > nowMs + FUTURE_SKEW_MS ? new Date(nowMs + FUTURE_SKEW_MS) : d;
}
