# @memoturn/sdk — production best practices

Practical guidance for running the SDK in production. Everything here reflects the actual
client implementation (`src/client.ts`), not aspiration.

## Keys and transport

- Load keys from `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` (the client falls back to them
  automatically) instead of hardcoding them. The client warns at construction if no keys are
  configured.
- Use `https://` for any non-local `baseUrl`. API keys travel in a Basic auth header, so the
  client warns once per origin when it would send them over cleartext `http://` to a non-local
  host. Plain-http LAN self-hosting is legitimate — opt out with `allowInsecureHttp: true` or
  `MEMOTURN_ALLOW_HTTP=1`.
- Never ship `secretKey` to a browser. Trace from your backend, or proxy ingest through it.

## Always flush before exit

`shutdown()` stops the background timer, deregisters the exit hook, and awaits a final flush:

```ts
await memoturn.shutdown();
```

The default `flushOnExit` hook on Node `beforeExit` is **best-effort only**: it fires the flush
without awaiting it, and `beforeExit` does not run on `process.exit()`, crashes, or signals.

**Serverless/edge caveat:** `beforeExit` effectively never fires on AWS Lambda (the runtime is
frozen, not exited) or edge runtimes like Cloudflare Workers. Flush explicitly at the end of
each invocation instead:

```ts
// Lambda: before returning        // Workers: don't block the response
await memoturn.flush();            ctx.waitUntil(memoturn.flush());
```

## Buffering, retries, and loss modes

Know the three ways events can be dropped, and size for them:

- **Buffer cap.** The buffer holds at most `maxBufferSize` events (default 10 000, or
  `MEMOTURN_MAX_BUFFER_SIZE`). When it is full, *new* events are dropped with a one-time
  warning — usually a sign the API is unreachable.
- **Transient failures** (network errors, timeouts, HTTP 5xx/408/429) put the failed batch
  back *ahead of* newer events and retry on the next flush; if that overflows the cap, the
  oldest events are dropped.
- **Permanent rejects** (other 4xx — bad keys, bad request) drop the batch immediately with a
  `console.error`; retrying can never succeed. Per-event schema rejects inside a 207 response
  are logged and not retried either.

For bursty high-volume apps, raise `maxBufferSize` and lower `flushAt`/`flushInterval` so the
buffer drains faster; the defaults (20 events / 5 s) suit typical request-scoped workloads.

## Mask PII before it leaves the process

The `mask` hook runs on the `input`, `output`, and `metadata` of **every** event at enqueue
time — including events produced by `wrapOpenAI`/`wrapAnthropic`, the LangChain callback, and
`observe`. If it throws, the value is replaced with a sentinel; the raw value is never sent.

```ts
const memoturn = new Memoturn({
  mask: (value, ctx) => {
    if (ctx.field === "metadata") return value;
    return JSON.parse(JSON.stringify(value).replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"));
  },
});
```

Masking happens before buffering, so masked data is also what a retry re-sends.

## Timeouts

Every SDK HTTP call uses `AbortSignal.timeout` (default 10 s, `requestTimeout`). Timeouts are
treated as transient, so the batch is re-buffered and retried. Raise the timeout behind slow
proxies; on latency-sensitive request paths where you `await flush()`, consider lowering it so
a dead collector cannot stall the request for the full 10 s.

## Environments

Set the client-wide default once (`environment` option or `MEMOTURN_ENVIRONMENT`) and override
per trace when one process serves several: `memoturn.trace({ environment: "prod" })`. Child
observations and scores inherit the *trace's* environment, not the client default.

## Classify agentic spans

Typed observations light up agent analytics in the console. Prefer the helpers over plain
spans: `trace.agent()` for agent steps, `.tool()` for tool calls, `.generation()` for model
calls, `.event()` for point-in-time markers — or pass `observationType` (`RETRIEVER`,
`RERANKER`, `EMBEDDING`, `CHAIN`, `GUARDRAIL`, …) on any span. Retriever spans should attach
`retrievedDocuments` so RAG analysis works.

## Gate CI on eval scores

Record an experiment run per PR, then fail the pipeline when quality regresses:

```ts
import { evaluateGate } from "@memoturn/sdk";

const gate = await evaluateGate(
  {}, // creds from MEMOTURN_* env
  "qa",
  process.env.RUN_NAME!,
  { faithfulness: { min: 0.8 }, accuracy: { maxRegression: 0.05 } },
  { baselineRun: "main" },
);
if (!gate.passed) {
  console.error(gate.failures);
  process.exit(1);
}
```

`maxRegression` bounds require `baselineRun`; keep a canonical baseline run per default branch.

## Node vs browser

- The core client needs Node ≥ 18 APIs that also exist in modern runtimes (`fetch`,
  `crypto.randomUUID`, `AbortSignal.timeout`); auth-header building uses `Buffer`, which
  browser bundlers must shim. `flushOnExit` is a no-op outside Node.
- `@memoturn/sdk/observe` is **Node-only** (it imports `node:async_hooks`) — that is why it is
  a subpath export and not in the package barrel. The same goes for `@memoturn/sdk/otel`.
- In browsers, prefer sending events to your own backend and tracing there — see the key
  warning above.
