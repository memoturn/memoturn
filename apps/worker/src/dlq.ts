/**
 * Whether a failed ingest job should be dead-lettered (its blob-backed batch preserved for
 * inspection/replay) rather than dropped.
 *
 * Two terminal cases:
 *  - retries exhausted (`attemptsMade >= maxAttempts`), the normal path; and
 *  - a STALLED job: a worker crash / OOM / event-loop wedge makes BullMQ move the job to `failed`
 *    once it exceeds `maxStalledCount`, but with `attemptsMade` possibly still below `attempts`.
 *    Gating the DLQ purely on the attempt counter would silently lose these — they'd sit in the
 *    failed set (capped by removeOnFail) and eventually be evicted, never replayed.
 */
export function shouldDeadLetter(errorMessage: string, attemptsMade: number, maxAttempts: number): boolean {
  if (attemptsMade >= maxAttempts) return true;
  return /stalled more than allowable/i.test(errorMessage);
}
