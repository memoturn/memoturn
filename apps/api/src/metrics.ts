/**
 * Lightweight in-process API observability: structured request logging + request metrics
 * (counts, status classes, per-route latency percentiles, in-flight gauge). In-memory —
 * good enough for a single/replicated deploy and a foundation for a real Prometheus client
 * later, mirroring the worker's metrics module. Scraped via the token-gated /metrics route.
 */

const startedAt = Date.now();

let requestsTotal = 0;
let inFlight = 0;
const statusClasses: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };

// Per-route rollup keyed by `METHOD routePattern` (route PATTERN, not the raw path, so
// /v1/traces/:id stays one bucket instead of exploding by id).
interface RouteStat {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number; // 5xx
  samples: number[]; // capped ring of recent latencies for percentiles
}
const routes = new Map<string, RouteStat>();
const MAX_SAMPLES = 128;

function classOf(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export function requestStarted(): void {
  inFlight += 1;
}

export function recordRequest(method: string, route: string, status: number, ms: number): void {
  requestsTotal += 1;
  inFlight = Math.max(0, inFlight - 1);
  statusClasses[classOf(status)] = (statusClasses[classOf(status)] ?? 0) + 1;

  const key = `${method} ${route}`;
  let s = routes.get(key);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, errors: 0, samples: [] };
    routes.set(key, s);
  }
  s.count += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (status >= 500) s.errors += 1;
  s.samples.push(ms);
  if (s.samples.length > MAX_SAMPLES) s.samples.shift();
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}

/** Snapshot for the /metrics response. */
export function snapshot(): Record<string, unknown> {
  const routeStats = [...routes.entries()]
    .map(([route, s]) => ({
      route,
      count: s.count,
      errors: s.errors,
      avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
      p50Ms: percentile(s.samples, 0.5),
      p95Ms: percentile(s.samples, 0.95),
      maxMs: Math.round(s.maxMs),
    }))
    .sort((a, b) => b.count - a.count);
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestsTotal,
    inFlight,
    statusClasses,
    routes: routeStats,
  };
}

/** Structured (JSON) log line with a stable shape for log aggregation. */
export function logJson(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "memoturn-api", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
