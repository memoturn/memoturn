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

/** Structured (JSON) log line with a stable shape for log aggregation. */
export function logJson(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "memoturn-worker", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
