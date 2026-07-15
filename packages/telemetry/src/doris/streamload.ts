import type { TelemetryRowMap, TelemetryTable } from "../types.js";
import { dorisConfig } from "./client.js";
import { toDorisDateTime } from "./serialize.js";

/**
 * Doris Stream Load — HTTP bulk ingest, an alternative to the multi-row INSERT path.
 *
 * Why: Stream Load is Doris's high-throughput import channel; it also loads `ARRAY<FLOAT>`
 * (embedding vectors) natively as JSON, avoiding the per-element placeholder dance the SQL
 * path needs. Each load is a transaction keyed by an optional `label` — reusing a
 * successful label is rejected, which gives us at-most-once idempotency for job retries.
 * Merge-on-write + last-writer-wins still works because `event_ts` is the table's declared
 * sequence column and rides along in the JSON.
 *
 * Endpoint: by default the FE HTTP port (8030), which 307-redirects to a BE — we follow the
 * redirect manually and RE-SEND the Authorization header (fetch strips it cross-origin,
 * which is exactly what curl's `--location-trusted` guards against). Point
 * `DORIS_STREAM_LOAD_PORT` at a BE HTTP port (8040) to load a BE directly and skip the
 * redirect (useful when the FE-advertised BE address isn't routable from the client).
 */

// Row fields that are ISO-8601 timestamps and must be reformatted to Doris DATETIME(3).
const DATETIME_KEYS = new Set(["timestamp", "event_ts", "start_time", "end_time"]);

export interface StreamLoadResult {
  status: string;
  loaded: number;
  message: string;
}

function streamLoadBase(): { host: string; port: number; auth: string; database: string } {
  const cfg = dorisConfig();
  return {
    host: process.env.DORIS_STREAM_LOAD_HOST ?? cfg.host,
    port: Number(process.env.DORIS_STREAM_LOAD_PORT ?? 8030),
    auth: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`,
    database: cfg.database,
  };
}

/**
 * Map engine-neutral rows → Stream Load JSON records (ISO timestamps → Doris DATETIME).
 * `_table` only binds the generic so `rows` is typed per table; it isn't read here.
 */
export function toStreamLoadRecords<T extends TelemetryTable>(
  _table: T,
  rows: TelemetryRowMap[T][],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as unknown as Record<string, unknown>)) {
      out[k] = DATETIME_KEYS.has(k) ? (v == null ? null : toDorisDateTime(v as string)) : v;
    }
    return out;
  });
}

/** PUT with manual redirect handling so the FE→BE 307 keeps the Authorization header. */
async function putFollowingRedirect(url: string, body: string, headers: Record<string, string>): Promise<Response> {
  let target = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(target, { method: "PUT", headers, body, redirect: "manual" });
    if (res.status === 307 || res.status === 308) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      target = loc; // re-send with the SAME headers (auth included) to the BE
      continue;
    }
    return res;
  }
  throw new Error("stream load: too many redirects");
}

/**
 * Load rows into `table` via Stream Load. Returns the parsed result; throws on a load
 * failure. A duplicate `label` (a retried successful load) is treated as success.
 */
export async function streamLoad<T extends TelemetryTable>(
  table: T,
  rows: TelemetryRowMap[T][],
  label?: string,
): Promise<StreamLoadResult> {
  if (rows.length === 0) return { status: "Success", loaded: 0, message: "" };
  const { host, port, auth, database } = streamLoadBase();
  const url = `http://${host}:${port}/api/${database}/${table}/_stream_load`;
  const body = JSON.stringify(toStreamLoadRecords(table, rows));

  const headers: Record<string, string> = {
    Authorization: auth,
    // NB: no `Expect: 100-continue` — curl uses it, but fetch (undici) rejects the header
    // and Doris doesn't require it; the body is just sent up front.
    "Content-Type": "application/json",
    format: "json",
    strip_outer_array: "true",
    // event_ts is the table's merge-on-write sequence column — carry it so LWW holds.
    "function_column.sequence_col": "event_ts",
  };
  if (label) headers.label = label;

  const res = await putFollowingRedirect(url, body, headers);
  const text = await res.text();
  let json: { Status?: string; Message?: string; NumberLoadedRows?: number; ErrorURL?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`stream load ${table}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const status = json.Status ?? "";
  // "Label Already Exists" = a retried load whose first attempt already committed → idempotent.
  if (status === "Success" || status === "Publish Timeout" || status === "Label Already Exists") {
    return { status, loaded: Number(json.NumberLoadedRows ?? 0), message: json.Message ?? "" };
  }
  throw new Error(`stream load ${table} failed: ${status} — ${json.Message ?? ""} ${json.ErrorURL ?? ""}`.trim());
}

/** Whether the Stream Load ingest path is enabled (opt-in; INSERT remains the default). */
export function streamLoadEnabled(): boolean {
  return process.env.TELEMETRY_STREAM_LOAD === "true" || process.env.TELEMETRY_STREAM_LOAD === "1";
}
