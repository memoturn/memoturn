// Internal helper shared by the OpenAI/Anthropic wrappers to observe streaming responses
// without buffering them. Not exported from the package barrel — imported directly by
// ./openai.ts and ./anthropic.ts via a relative import.

export interface StreamRecorder<TChunk = any> {
  onChunk(chunk: TChunk): void;
  /** Called exactly once: "complete" (normal exhaustion), "error", or "abandoned" (caller broke/returned early, or an idle timeout fired). */
  onDone(err: unknown | undefined, reason: "complete" | "error" | "abandoned"): void;
}

/**
 * Wrap an async-iterable SDK stream so every chunk is still yielded to the caller in real
 * time (no buffering, no added latency) while `recorder` observes it. All non-iteration
 * properties of `stream` (e.g. `.controller`) pass through untouched via Proxy.
 */
export function tapStream<T extends object>(
  stream: T,
  recorder: StreamRecorder,
  options?: { idleTimeoutMs?: number },
): T {
  let done = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const finish = (err: unknown, reason: "complete" | "error" | "abandoned"): void => {
    if (done) return;
    done = true;
    clearIdleTimer();
    try {
      recorder.onDone(err, reason);
    } catch {
      // A bug in the accumulator must never break the caller's stream.
    }
  };

  const armIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => finish(undefined, "abandoned"), options?.idleTimeoutMs ?? 120_000);
    idleTimer.unref?.();
  };

  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const realIterator = (target as any)[Symbol.asyncIterator]();
          armIdleTimer();

          return {
            async next(...args: unknown[]) {
              let result: IteratorResult<unknown>;
              try {
                result = await realIterator.next(...args);
              } catch (err) {
                finish(err, "error");
                throw err;
              }
              if (result.done) {
                finish(undefined, "complete");
              } else {
                try {
                  recorder.onChunk(result.value);
                } catch {
                  // Never let a bug in the accumulator break the caller's stream.
                }
                armIdleTimer();
              }
              return result;
            },
            async return(value?: unknown) {
              // for-await + break calls the iterator's return() — this is the caller
              // stopping early, deterministically distinct from natural exhaustion.
              finish(undefined, "abandoned");
              if (typeof realIterator.return === "function") return realIterator.return(value);
              return { done: true, value };
            },
            async throw(err?: unknown) {
              finish(err, "error");
              if (typeof realIterator.throw === "function") return realIterator.throw(err);
              throw err;
            },
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
