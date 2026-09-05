/**
 * Lightweight worker metrics + structured logging. Pipeline failures must be observable:
 * a project could otherwise lose 100% of ingestion silently. Counters are in-process
 * (scraped via the worker's /metrics endpoint) — good enough for a single-worker deploy
 * and a foundation for a real Prometheus client later.
 */
type Labels = Record<string, string>;

const counters = new Map<string, number>();
let insertCount = 0;
let insertMsTotal = 0;

function keyOf(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${name}{${parts}}`;
}

/** Increment a counter (optionally labeled). */
export function inc(name: string, labels?: Labels, by = 1): void {
  const k = keyOf(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Record one telemetry-store insert latency sample (ms). */
export function observeInsert(ms: number): void {
  insertCount += 1;
  insertMsTotal += ms;
}

/** Snapshot all metrics as a plain object (embedded in the /metrics JSON response). */
export function snapshot(): Record<string, unknown> {
  return {
    counters: Object.fromEntries(counters),
    telemetry_insert: {
      count: insertCount,
      avgMs: insertCount ? Math.round(insertMsTotal / insertCount) : 0,
    },
  };
}

/**
 * Prometheus text exposition of the same data (text/plain; version=0.0.4). Counter keys are
 * already in `name{label="v"}` form (see keyOf), so they map 1:1 onto metric lines under the
 * `memoturn_worker_` prefix; queue depths are passed in by the health server as gauges.
 */
export function renderPrometheus(
  queues: Record<string, Record<string, number | undefined>>,
  extra: { concurrency: number; dlqDepth: number },
): string {
  const out: string[] = [];
  out.push("# HELP memoturn_worker_concurrency Configured ingest concurrency.");
  out.push("# TYPE memoturn_worker_concurrency gauge");
  out.push(`memoturn_worker_concurrency ${extra.concurrency}`);
  out.push("# HELP memoturn_worker_dlq_depth Dead-lettered ingest batches awaiting inspection/replay.");
  out.push("# TYPE memoturn_worker_dlq_depth gauge");
  out.push(`memoturn_worker_dlq_depth ${extra.dlqDepth}`);
  out.push("# HELP memoturn_worker_queue_jobs BullMQ jobs per queue and state.");
  out.push("# TYPE memoturn_worker_queue_jobs gauge");
  for (const [queue, states] of Object.entries(queues)) {
    for (const [state, n] of Object.entries(states)) {
      if (typeof n === "number") out.push(`memoturn_worker_queue_jobs{queue="${queue}",state="${state}"} ${n}`);
    }
  }
  out.push("# HELP memoturn_worker_telemetry_insert_ms_sum Total telemetry-store insert time (ms).");
  out.push("# TYPE memoturn_worker_telemetry_insert_ms_sum counter");
  out.push(`memoturn_worker_telemetry_insert_ms_sum ${insertMsTotal}`);
  out.push("# HELP memoturn_worker_telemetry_insert_count Telemetry-store insert calls.");
  out.push("# TYPE memoturn_worker_telemetry_insert_count counter");
  out.push(`memoturn_worker_telemetry_insert_count ${insertCount}`);
  const seen = new Set<string>();
  for (const [key, value] of counters) {
    const name = key.split("{")[0] ?? key;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(`# TYPE memoturn_worker_${name} counter`);
    }
    out.push(`memoturn_worker_${key} ${value}`);
  }
  return `${out.join("\n")}\n`;
}

/** True when the scraper asked for the Prometheus text format (or `?format=prometheus`). */
export function wantsPrometheus(accept: string | undefined, format: string | undefined): boolean {
  if (format === "prometheus" || format === "text") return true;
  if (format === "json") return false;
  const a = accept ?? "";
  return a.includes("text/plain") || a.includes("openmetrics");
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// LOG_LEVEL gates what is emitted (default info); the per-batch "ingest ok" line is `info`.
const MIN_LEVEL = LEVEL_RANK[(process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel] ?? LEVEL_RANK.info;

/** Structured (JSON) log line with a stable shape for log aggregation. */
export function logJson(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_RANK[level] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "memoturn-worker", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
