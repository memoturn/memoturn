import { basicAuth, DEFAULT_REQUEST_TIMEOUT_MS, truncate, warnIfInsecure } from "./internal.js";
import type {
  GenerationInput,
  IngestEnvelope,
  MaskFunction,
  MemoturnOptions,
  ScoreInput,
  SpanInput,
  TraceInput,
} from "./types.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";

function uuid(): string {
  // Works in Node 18+ and browsers.
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function envInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 5xx and explicit backpressure/timeout statuses are worth retrying; other 4xx are permanent. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Hard limits of `POST /v1/ingest`: at most 1000 events per request and a 12 MB body. A
 * flush never sends more than one request's worth at a time — the buffer can hold far more
 * than one request (it exists to ride out an outage), and a single over-limit POST would be
 * rejected as a permanent 400/413 and drop everything it carried.
 */
const MAX_BATCH_EVENTS = 1000;
const MAX_BATCH_BYTES = 10 * 1024 * 1024; // headroom under the API's 12 MB cap (envelope + sdk fields)
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** A retryable ingest failure — the chunk is re-buffered and the client backs off. */
class TransientIngestError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BACKOFF_MAX_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), BACKOFF_MAX_MS)) : undefined;
}

/**
 * Split a buffer into request-sized chunks (by event count AND serialized bytes). An event
 * that alone exceeds the byte cap can never be accepted — it is dropped here with an error
 * rather than poisoning the chunk it would ride in.
 */
function chunkBatch(events: IngestEnvelope[], maxEvents: number): IngestEnvelope[][] {
  const chunks: IngestEnvelope[][] = [];
  let current: IngestEnvelope[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const bytes = JSON.stringify(event).length + 1;
    if (bytes > MAX_BATCH_BYTES) {
      console.error(`memoturn: dropping event ${event.id} (${event.type}) — ${bytes} bytes exceeds the ingest limit`);
      continue;
    }
    if (current.length >= maxEvents || currentBytes + bytes > MAX_BATCH_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Opt-in signal hook: flush every registered client on SIGTERM/SIGINT, then re-raise the
// signal so the process still terminates the way it would have. `beforeExit` (the default
// hook) never fires on a signal, which is how containers are stopped.
const signalFlushRegistry = new Set<() => Promise<void>>();
let signalHookInstalled = false;

function registerSignalFlush(flush: () => Promise<void>): void {
  if (typeof process === "undefined" || typeof process.once !== "function") return;
  signalFlushRegistry.add(flush);
  if (signalHookInstalled) return;
  signalHookInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void Promise.allSettled([...signalFlushRegistry].map((f) => f())).finally(() => process.kill(process.pid, sig));
    });
  }
}

// One process-level exit hook shared by every client — per-client listeners would
// leak (and trip MaxListenersExceeded) in apps that construct many clients.
const exitFlushRegistry = new Set<() => void>();
let exitHookInstalled = false;

function registerExitFlush(flush: () => void): void {
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  exitFlushRegistry.add(flush);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("beforeExit", () => {
    for (const f of exitFlushRegistry) f();
  });
}

/**
 * memoturn SDK client. Buffers events and flushes batches to `POST /v1/ingest`.
 * Create trace/span/generation handles and call `.end()` as work completes; the
 * client handles ids, timestamps, batching, and auth.
 */
export class Memoturn {
  private readonly baseUrl: string;
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly environment: string;
  private readonly flushAt: number;
  private readonly flushInterval: number;
  private readonly maxBufferSize: number;
  private readonly maxBatchSize: number;
  private readonly requestTimeout: number;
  private readonly mask: MaskFunction | undefined;
  private readonly exitHandler: (() => void) | undefined;
  private buffer: IngestEnvelope[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private warnedBufferFull = false;
  // Backoff state for background flushes: consecutive transient failures, and the earliest
  // time the timer/size trigger may try again. An explicit `flush()` always tries.
  private transientFailures = 0;
  private backoffUntil = 0;

  constructor(options: MemoturnOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
    this.publicKey = options.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
    this.environment = options.environment ?? process.env.MEMOTURN_ENVIRONMENT ?? "default";
    this.flushAt = options.flushAt ?? 20;
    this.flushInterval = options.flushInterval ?? 5000;
    this.maxBufferSize = options.maxBufferSize ?? envInt("MEMOTURN_MAX_BUFFER_SIZE") ?? 10_000;
    this.maxBatchSize = Math.min(MAX_BATCH_EVENTS, Math.max(1, options.maxBatchSize ?? MAX_BATCH_EVENTS));
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.mask = options.mask;

    warnIfInsecure(this.baseUrl, options.allowInsecureHttp);
    if (!this.publicKey && !this.secretKey) {
      console.warn(
        "memoturn: no API keys configured (pass publicKey/secretKey or set MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY) — ingest will be unauthorized",
      );
    }
    if (options.flushOnExit ?? true) {
      this.exitHandler = () => void this.flushQuietly();
      registerExitFlush(this.exitHandler);
    }
    if (options.flushOnSignals) registerSignalFlush(() => this.flush().catch(() => {}));
  }

  /** Start a trace. Returns a handle for adding child observations + scores. */
  trace(input: TraceInput = {}): MemoturnTrace {
    const id = input.id ?? uuid();
    const environment = input.environment ?? this.environment;
    this.enqueue({
      id: uuid(),
      type: "trace-create",
      timestamp: nowIso(),
      body: { ...input, id, environment },
    });
    return new MemoturnTrace(this, id, environment);
  }

  /** @internal */
  enqueue(event: IngestEnvelope): void {
    if (this.buffer.length >= this.maxBufferSize) {
      if (!this.warnedBufferFull) {
        this.warnedBufferFull = true;
        console.warn(
          `memoturn: event buffer full (${this.maxBufferSize}), dropping new events — is the API reachable?`,
        );
      }
      return;
    }
    this.buffer.push(this.mask ? this.applyMask(event) : event);
    if (this.buffer.length >= this.flushAt) void this.flushQuietly();
    else this.ensureTimer();
  }

  private applyMask(event: IngestEnvelope): IngestEnvelope {
    const body = { ...event.body };
    for (const field of ["input", "output", "metadata"] as const) {
      if (body[field] === undefined) continue;
      try {
        body[field] = this.mask?.(body[field], { field, type: event.type });
      } catch {
        // Never lose the event — and never leak the unmasked value.
        body[field] = "<memoturn: mask error>";
      }
    }
    return { ...event, body };
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flushQuietly(), this.flushInterval);
    // Don't keep the process alive just for the flush timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Flush without throwing — used by the size trigger, the timer, and the exit hook. Honors
   * the backoff window after a transient failure so a fleet of clients doesn't hammer a
   * recovering API in lockstep every `flushInterval`.
   */
  private async flushQuietly(): Promise<void> {
    if (Date.now() < this.backoffUntil) return;
    try {
      await this.flush();
    } catch (err) {
      console.error(`memoturn: background flush failed: ${truncate(String(err))}`);
    }
  }

  private noteTransientFailure(retryAfter: number | undefined): void {
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.transientFailures);
    const jitter = 0.75 + Math.random() * 0.5; // ±25% so retries de-synchronize across processes
    const delay = retryAfter ?? Math.round(exp * jitter);
    this.transientFailures = Math.min(this.transientFailures + 1, 16);
    this.backoffUntil = Date.now() + delay;
  }

  /** Put a failed batch back ahead of newer events, keeping the newest up to the cap. */
  private rebuffer(batch: IngestEnvelope[]): void {
    const combined = batch.concat(this.buffer);
    const overflow = combined.length - this.maxBufferSize;
    this.buffer = overflow > 0 ? combined.slice(overflow) : combined;
    if (overflow > 0 && !this.warnedBufferFull) {
      this.warnedBufferFull = true;
      console.warn(`memoturn: event buffer full (${this.maxBufferSize}), dropped ${overflow} oldest event(s)`);
    }
  }

  /**
   * Send all buffered events now, in request-sized chunks (≤ 1000 events / ~10 MB each).
   * Safe to call repeatedly. A transient failure re-buffers the failing chunk and every
   * chunk after it (nothing is lost, order is kept) and throws; a permanent reject drops
   * only that chunk and continues, throwing after the rest has been sent.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    const chunks = chunkBatch(pending, this.maxBatchSize);

    let firstReject: Error | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as IngestEnvelope[];
      try {
        await this.send(chunk);
      } catch (err) {
        if (err instanceof TransientIngestError) {
          this.rebuffer(chunks.slice(i).flat());
          this.noteTransientFailure(err.retryAfterMs);
          throw new Error(err.message);
        }
        firstReject ??= err as Error;
      }
    }
    this.transientFailures = 0;
    this.backoffUntil = 0;
    if (firstReject) throw firstReject;
  }

  /** One `POST /v1/ingest`. Throws TransientIngestError (retry) or Error (permanent reject). */
  private async send(batch: IngestEnvelope[]): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth(this.publicKey, this.secretKey) },
        body: JSON.stringify({ batch, sdk: { name: SDK_NAME, version: SDK_VERSION } }),
        signal: AbortSignal.timeout(this.requestTimeout),
      });
    } catch (err) {
      // Network failure or timeout — transient: re-buffer so the next flush retries.
      throw new TransientIngestError(`memoturn ingest failed: ${truncate(String(err))}`, undefined);
    }

    if (!res.ok && res.status !== 207) {
      const detail = truncate(await res.text().catch(() => ""));
      if (isTransientStatus(res.status)) {
        throw new TransientIngestError(`memoturn ingest failed: ${res.status} ${detail}`, retryAfterMs(res));
      }
      // Permanent reject (bad request/auth) — retrying can never succeed; drop the batch.
      console.error(`memoturn: dropping ${batch.length} event(s) rejected at ingest: ${res.status} ${detail}`);
      throw new Error(`memoturn ingest rejected: ${res.status} ${detail}`);
    }

    // The 207 body reports per-event results; surface rejected events instead of
    // silently dropping them (they are NOT retried — a schema reject is permanent).
    if (res.status === 207) {
      const body = (await res.json().catch(() => null)) as {
        errors?: { id: string; index?: number; error?: string }[];
      } | null;
      if (body?.errors?.length) {
        console.warn(
          `memoturn: ${body.errors.length} event(s) rejected at ingest — first: ${body.errors[0]?.error ?? "invalid event"}`,
        );
      }
    }
  }

  /** Flush and stop the background timer. Call before process exit. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.exitHandler) exitFlushRegistry.delete(this.exitHandler);
    await this.flush();
  }
}

export class MemoturnTrace {
  constructor(
    private readonly client: Memoturn,
    public readonly id: string,
    private readonly environment: string,
  ) {}

  update(input: Partial<TraceInput>): this {
    this.client.enqueue({
      id: uuid(),
      type: "trace-create",
      timestamp: nowIso(),
      body: { ...input, id: this.id, environment: this.environment },
    });
    return this;
  }

  span(input: SpanInput = {}): MemoturnSpan {
    const id = input.id ?? uuid();
    this.client.enqueue({
      id: uuid(),
      type: "span-create",
      timestamp: nowIso(),
      body: { ...input, id, traceId: this.id, environment: this.environment, startTime: nowIso() },
    });
    return new MemoturnSpan(this.client, this.id, id, this.environment, "span");
  }

  generation(input: GenerationInput = {}): MemoturnSpan {
    const id = input.id ?? uuid();
    this.client.enqueue({
      id: uuid(),
      type: "generation-create",
      timestamp: nowIso(),
      body: { ...input, id, traceId: this.id, environment: this.environment, startTime: nowIso() },
    });
    return new MemoturnSpan(this.client, this.id, id, this.environment, "generation");
  }

  /** A tool-call span (classified TOOL). */
  tool(input: SpanInput = {}): MemoturnSpan {
    return this.span({ ...input, observationType: "TOOL" });
  }

  /** An agent-step span (classified AGENT). */
  agent(input: SpanInput = {}): MemoturnSpan {
    return this.span({ ...input, observationType: "AGENT" });
  }

  event(input: SpanInput = {}): void {
    this.client.enqueue({
      id: uuid(),
      type: "event-create",
      timestamp: nowIso(),
      body: { ...input, id: input.id ?? uuid(), traceId: this.id, environment: this.environment, startTime: nowIso() },
    });
  }

  score(input: ScoreInput): this {
    this.client.enqueue({
      id: uuid(),
      type: "score-create",
      timestamp: nowIso(),
      body: { ...input, id: input.id ?? uuid(), traceId: this.id, environment: this.environment },
    });
    return this;
  }
}

export class MemoturnSpan {
  constructor(
    private readonly client: Memoturn,
    private readonly traceId: string,
    public readonly id: string,
    private readonly environment: string,
    private readonly kind: "span" | "generation",
  ) {}

  /** Nested child span. */
  span(input: SpanInput = {}): MemoturnSpan {
    const id = input.id ?? uuid();
    this.client.enqueue({
      id: uuid(),
      type: "span-create",
      timestamp: nowIso(),
      body: {
        ...input,
        id,
        traceId: this.traceId,
        parentObservationId: this.id,
        environment: this.environment,
        startTime: nowIso(),
      },
    });
    return new MemoturnSpan(this.client, this.traceId, id, this.environment, "span");
  }

  /** Nested child generation. */
  generation(input: GenerationInput = {}): MemoturnSpan {
    const id = input.id ?? uuid();
    this.client.enqueue({
      id: uuid(),
      type: "generation-create",
      timestamp: nowIso(),
      body: {
        ...input,
        id,
        traceId: this.traceId,
        parentObservationId: this.id,
        environment: this.environment,
        startTime: nowIso(),
      },
    });
    return new MemoturnSpan(this.client, this.traceId, id, this.environment, "generation");
  }

  /** Nested point-in-time event (no `.end()` — it is emitted immediately). */
  event(input: SpanInput = {}): void {
    this.client.enqueue({
      id: uuid(),
      type: "event-create",
      timestamp: nowIso(),
      body: {
        ...input,
        id: input.id ?? uuid(),
        traceId: this.traceId,
        parentObservationId: this.id,
        environment: this.environment,
        startTime: nowIso(),
      },
    });
  }

  /** Nested tool-call span (classified TOOL). */
  tool(input: SpanInput = {}): MemoturnSpan {
    return this.span({ ...input, observationType: "TOOL" });
  }

  /** Nested agent-step span (classified AGENT). */
  agent(input: SpanInput = {}): MemoturnSpan {
    return this.span({ ...input, observationType: "AGENT" });
  }

  /** Update + close the observation. Pass `output` and (for generations) `usage`. */
  end(input: Partial<GenerationInput> = {}): void {
    this.client.enqueue({
      id: uuid(),
      type: this.kind === "generation" ? "generation-update" : "span-update",
      timestamp: nowIso(),
      body: { ...input, id: this.id, traceId: this.traceId, environment: this.environment, endTime: nowIso() },
    });
  }
}
