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
  private readonly requestTimeout: number;
  private readonly mask: MaskFunction | undefined;
  private readonly exitHandler: (() => void) | undefined;
  private buffer: IngestEnvelope[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private warnedBufferFull = false;

  constructor(options: MemoturnOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
    this.publicKey = options.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
    this.environment = options.environment ?? process.env.MEMOTURN_ENVIRONMENT ?? "default";
    this.flushAt = options.flushAt ?? 20;
    this.flushInterval = options.flushInterval ?? 5000;
    this.maxBufferSize = options.maxBufferSize ?? envInt("MEMOTURN_MAX_BUFFER_SIZE") ?? 10_000;
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

  /** Flush without throwing — used by the size trigger, the timer, and the exit hook. */
  private async flushQuietly(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      console.error(`memoturn: background flush failed: ${truncate(String(err))}`);
    }
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

  /** Send all buffered events now. Safe to call repeatedly. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuth(this.publicKey, this.secretKey) },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(this.requestTimeout),
      });
    } catch (err) {
      // Network failure or timeout — transient: re-buffer so the next flush retries.
      this.rebuffer(batch);
      throw new Error(`memoturn ingest failed: ${truncate(String(err))}`);
    }

    if (!res.ok && res.status !== 207) {
      const detail = truncate(await res.text().catch(() => ""));
      if (isTransientStatus(res.status)) {
        // Re-buffer on transient failure so the next flush retries.
        this.rebuffer(batch);
        throw new Error(`memoturn ingest failed: ${res.status} ${detail}`);
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
