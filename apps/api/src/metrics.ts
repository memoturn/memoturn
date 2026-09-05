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

// ── Prometheus exposition ─────────────────────────────────────────────────────────
// The same snapshot rendered as text/plain; version=0.0.4 so a stock Prometheus/Grafana/
// Alertmanager stack can scrape it. Percentiles are exported as gauges (they are computed
// from a bounded ring of recent samples, not a true histogram) — good enough for alerting
// on a route's p95, and honest about what they are.
function promLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderPrometheus(): string {
  const out: string[] = [];
  const line = (name: string, value: number, labels?: Record<string, string>) => {
    const l = labels
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${promLabel(v)}"`)
          .join(",")}}`
      : "";
    out.push(`${name}${l} ${value}`);
  };
  out.push("# HELP memoturn_api_uptime_seconds Seconds since the API process started.");
  out.push("# TYPE memoturn_api_uptime_seconds gauge");
  line("memoturn_api_uptime_seconds", Math.floor((Date.now() - startedAt) / 1000));
  out.push("# HELP memoturn_api_requests_total HTTP requests handled since start.");
  out.push("# TYPE memoturn_api_requests_total counter");
  line("memoturn_api_requests_total", requestsTotal);
  out.push("# HELP memoturn_api_requests_in_flight Requests currently being handled.");
  out.push("# TYPE memoturn_api_requests_in_flight gauge");
  line("memoturn_api_requests_in_flight", inFlight);
  out.push("# HELP memoturn_api_responses_total Responses by status class.");
  out.push("# TYPE memoturn_api_responses_total counter");
  for (const [cls, n] of Object.entries(statusClasses)) line("memoturn_api_responses_total", n, { class: cls });
  out.push("# HELP memoturn_api_route_requests_total Requests per route pattern.");
  out.push("# TYPE memoturn_api_route_requests_total counter");
  out.push("# HELP memoturn_api_route_errors_total 5xx responses per route pattern.");
  out.push("# TYPE memoturn_api_route_errors_total counter");
  out.push("# HELP memoturn_api_route_latency_ms Recent-sample latency percentiles per route (ms).");
  out.push("# TYPE memoturn_api_route_latency_ms gauge");
  for (const [key, s] of routes) {
    const sp = key.indexOf(" ");
    const labels = { method: key.slice(0, sp), route: key.slice(sp + 1) };
    line("memoturn_api_route_requests_total", s.count, labels);
    line("memoturn_api_route_errors_total", s.errors, labels);
    line("memoturn_api_route_latency_ms", percentile(s.samples, 0.5), { ...labels, quantile: "0.5" });
    line("memoturn_api_route_latency_ms", percentile(s.samples, 0.95), { ...labels, quantile: "0.95" });
    line("memoturn_api_route_latency_ms", Math.round(s.maxMs), { ...labels, quantile: "max" });
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

// ── Structured logging ─────────────────────────────────────────────────────────────
type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// LOG_LEVEL gates what is emitted (default info). The per-request access line is `info`,
// so `LOG_LEVEL=warn` silences it on a busy install without losing errors.
const MIN_LEVEL = LEVEL_RANK[(process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel] ?? LEVEL_RANK.info;

/** Structured (JSON) log line with a stable shape for log aggregation. */
export function logJson(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_RANK[level] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "memoturn-api", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
