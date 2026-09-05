/**
 * Whether a failed ingest job should be dead-lettered (its blob-backed batch preserved for
 * inspection/replay) rather than dropped.
 *
 * Three terminal cases:
 *  - retries exhausted (`attemptsMade >= maxAttempts`), the normal path; and
 *  - a STALLED job: a worker crash / OOM / event-loop wedge makes BullMQ move the job to `failed`
 *    once it exceeds `maxStalledCount`, but with `attemptsMade` possibly still below `attempts`.
 *    Gating the DLQ purely on the attempt counter would silently lose these — they'd sit in the
 *    failed set (capped by removeOnFail) and eventually be evicted, never replayed; and
 *  - an UNRECOVERABLE failure (`unrecoverable:` prefix — blob missing/malformed), which the
 *    processor raises on attempt 1 to skip the pointless retry ladder.
 */
export function shouldDeadLetter(errorMessage: string, attemptsMade: number, maxAttempts: number): boolean {
  if (attemptsMade >= maxAttempts) return true;
  // An UnrecoverableError (missing/malformed blob) fails on attempt 1 by design — the
  // processor prefixes the message so we can tell it from a retryable failure.
  if (/^unrecoverable:/i.test(errorMessage)) return true;
  return /stalled more than allowable/i.test(errorMessage);
}
