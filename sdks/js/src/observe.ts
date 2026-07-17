// Node-only auto-instrumentation — the JS analogue of the Python SDK's @observe decorator.
// Uses AsyncLocalStorage (node:async_hooks) so nesting works across sync and async call
// stacks. Because of that import this module is NOT re-exported from the package barrel;
// import it via the subpath: `import { observe } from "@memoturn/sdk/observe"`.

import { AsyncLocalStorage } from "node:async_hooks";
import { Memoturn, type MemoturnSpan, type MemoturnTrace } from "./client.js";
import type { TraceInput } from "./types.js";

interface ObserveContext {
  trace: MemoturnTrace;
  span: MemoturnSpan;
}

const storage = new AsyncLocalStorage<ObserveContext>();

let defaultClient: Memoturn | undefined;

/** Set the default client used by `observe` (and returned by `getClient`). */
export function configure(client: Memoturn): Memoturn {
  defaultClient = client;
  return client;
}

/** The default client for `observe` — lazily constructed from env vars if not configured. */
export function getClient(): Memoturn {
  defaultClient ??= new Memoturn();
  return defaultClient;
}

/**
 * Update the current trace's userId/sessionId/tags/metadata from anywhere inside an active
 * observe()-wrapped call stack — no need to hold a reference to the trace/span. Delegates to
 * MemoturnTrace.update(), so it has the same patch semantics: fields you omit keep their
 * previous value; tags/metadata are replaced wholesale, not merged.
 *
 * No-op (with a one-time console.warn) when called outside any active observe() context —
 * there is no trace to stamp. This deliberately never throws, matching observe()'s own
 * policy that observability plumbing must never break the caller's application logic.
 *
 * Scoped to observe()-context only: code using the manual .trace()/.span() API directly
 * already holds a MemoturnTrace reference and should call trace.update(...) itself.
 */
export function setTraceContext(input: Pick<TraceInput, "userId" | "sessionId" | "tags" | "metadata">): void {
  const ctx = storage.getStore();
  if (!ctx) {
    console.warn("memoturn: setTraceContext() called outside an active observe() context — ignored");
    return;
  }
  ctx.trace.update(input);
}

/**
 * Wrap a function so every call is traced. The outermost observed call opens a trace
 * (input `{ args }`) with a root observation; observed functions called within it become
 * nested child spans automatically. On resolve the observation ends with the return value
 * as `output` (the root also updates the trace output); on throw it ends with level ERROR
 * and the error as `statusMessage`, then rethrows. Works for sync and async functions.
 *
 *   const answer = observe(async function answer(q: string) { ... });
 *   const rerank = observe(rerankDocs, { name: "rerank" });
 *   const llm = observe(callModel, { asType: "generation" });
 */
export function observe<T extends (...args: any[]) => any>(
  fn: T,
  options: { name?: string; asType?: "span" | "generation" } = {},
): T {
  const name = options.name ?? (fn.name || "observed");
  const asType = options.asType ?? "span";

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const parent = storage.getStore();
    const isRoot = parent === undefined;
    const input = { args };

    let trace: MemoturnTrace;
    let span: MemoturnSpan;
    if (parent === undefined) {
      trace = getClient().trace({ name, input });
      span = asType === "generation" ? trace.generation({ name, input }) : trace.span({ name, input });
    } else {
      trace = parent.trace;
      span = asType === "generation" ? parent.span.generation({ name, input }) : parent.span.span({ name, input });
    }

    const finish = (output: unknown): void => {
      span.end({ output });
      if (isRoot) trace.update({ output });
    };
    const fail = (err: unknown): void => {
      span.end({ level: "ERROR", statusMessage: String(err) });
    };

    try {
      const result = storage.run({ trace, span }, () => fn.apply(this, args));
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        return (result as Promise<unknown>).then(
          (out) => {
            finish(out);
            return out;
          },
          (err) => {
            fail(err);
            throw err;
          },
        );
      }
      finish(result);
      return result;
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  return wrapped as T;
}
