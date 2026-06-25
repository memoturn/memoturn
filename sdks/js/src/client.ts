import type {
  GenerationInput,
  IngestEnvelope,
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
  private buffer: IngestEnvelope[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemoturnOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    this.publicKey = options.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
    this.environment = options.environment ?? process.env.MEMOTURN_ENVIRONMENT ?? "default";
    this.flushAt = options.flushAt ?? 20;
    this.flushInterval = options.flushInterval ?? 5000;
  }

  /** Start a trace. Returns a handle for adding child observations + scores. */
  trace(input: TraceInput = {}): MemoturnTrace {
    const id = input.id ?? uuid();
    this.enqueue({
      id: uuid(),
      type: "trace-create",
      timestamp: nowIso(),
      body: { ...input, id, environment: input.environment ?? this.environment },
    });
    return new MemoturnTrace(this, id, this.environment);
  }

  /** @internal */
  enqueue(event: IngestEnvelope): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.flushAt) void this.flush();
    else this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushInterval);
    // Don't keep the process alive just for the flush timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Send all buffered events now. Safe to call repeatedly. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
    });

    if (!res.ok && res.status !== 207) {
      // Re-buffer on transport failure so the next flush retries.
      this.buffer.unshift(...batch);
      throw new Error(`memoturn ingest failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Flush and stop the background timer. Call before process exit. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
      body: { ...input, id, traceId: this.traceId, parentObservationId: this.id, environment: this.environment, startTime: nowIso() },
    });
    return new MemoturnSpan(this.client, this.traceId, id, this.environment, "span");
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
