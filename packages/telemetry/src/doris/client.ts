import mysql from "mysql2";
import type { Pool } from "mysql2/promise";

/**
 * Shared Doris connection pool (MySQL protocol against the FE). Sessions are pinned to
 * UTC so DATETIME comparisons and NOW() match the ISO-8601 UTC timestamps memoturn
 * writes. `dateStrings` keeps DATETIME values as strings — timestamps are formatted in
 * SQL, never converted through JS Date.
 *
 * Connection resilience: Doris's MySQL `wait_timeout` closes idle connections server-side
 * (default 8h). A pooled connection the server has killed reads back as a fatal
 * PROTOCOL_CONNECTION_LOST / ECONNRESET on next use. We defend on two fronts:
 *   1. `idleTimeout` recycles idle connections well before the server times them out, and
 *      TCP keepalive keeps in-use connections healthy — so stale handles rarely happen.
 *   2. `dorisQuery` retries once on a fatal connection error — mysql2 evicts the dead
 *      connection, so the retry runs on a fresh one. This makes the store self-heal even
 *      if a stale handle slips through (the failure mode that used to 500 a quiet API).
 */
let base: mysql.Pool | undefined;
let promisePool: Pool | undefined;

export interface DorisConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Integer env knob with a fallback and bounds — a malformed value never becomes NaN. */
export function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Per-session query timeout (seconds). Doris enforces `query_timeout` server-side, so a
 * pathological scan is killed on the FE instead of holding one of the pool's connections
 * (and an API request) open indefinitely. Applied on every new pooled connection.
 */
export const DORIS_QUERY_TIMEOUT_S = envInt("DORIS_QUERY_TIMEOUT_S", 60, 1);

/** Replicas per tablet for new tables/partitions (DORIS_REPLICATION_NUM; 1 for the single-BE stacks). */
export const REPLICATION_NUM = envInt("DORIS_REPLICATION_NUM", 1, 1, 9);

export function dorisConfig(): DorisConfig {
  return {
    host: process.env.DORIS_HOST ?? "localhost",
    port: Number(process.env.DORIS_PORT ?? 9030),
    user: process.env.DORIS_USER ?? "root",
    password: process.env.DORIS_PASSWORD ?? "",
    database: process.env.DORIS_DB ?? "memoturn",
  };
}

/** Pool options shared by the app pool and the migration runner's standalone pool. */
function poolOptions(config: Partial<DorisConfig> = {}): mysql.PoolOptions {
  return {
    ...dorisConfig(),
    ...config,
    waitForConnections: true,
    // Size the pool per replica: replicas × DORIS_POOL_SIZE must stay under the FE's
    // max_connections (default 1024 in 4.x — but each FE connection also holds BE resources).
    connectionLimit: envInt("DORIS_POOL_SIZE", 10, 1, 1000),
    // A hung FE must fail fast instead of pinning a pool slot forever.
    connectTimeout: envInt("DORIS_CONNECT_TIMEOUT_MS", 10_000, 100),
    dateStrings: true,
    multipleStatements: false,
    // Recycle idle connections long before Doris's server-side wait_timeout (default 8h)
    // can kill them out from under the pool.
    idleTimeout: 60_000,
    maxIdle: 4,
    // TCP keepalive keeps in-use connections from being dropped by idle network middleboxes.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  };
}

/** True for errors that mean the pooled connection is dead — safe to retry on a fresh one. */
export function isFatalConnectionError(err: unknown): boolean {
  const e = err as { code?: string; fatal?: boolean; message?: string } | null;
  if (!e) return false;
  if (e.fatal) return true;
  const code = e.code ?? "";
  if (
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "CONNECTION_LOST"
  ) {
    return true;
  }
  const msg = e.message ?? "";
  return msg.includes("closed state") || msg.includes("ECONNRESET") || msg.includes("connection is in closed");
}

/** Create a standalone pool (used by the migration runner, which manages the database). */
export function createDorisPool(config: Partial<DorisConfig> = {}): Pool {
  const pool = mysql.createPool(poolOptions(config));
  pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
    conn.query(`SET query_timeout = ${DORIS_QUERY_TIMEOUT_S}`);
  });
  return pool.promise();
}

export function dorisPool(): Pool {
  if (!promisePool) {
    base = mysql.createPool(poolOptions());
    base.on("connection", (conn) => {
      conn.query("SET time_zone = '+00:00'");
      // Server-side kill switch for a runaway scan; see DORIS_QUERY_TIMEOUT_S.
      conn.query(`SET query_timeout = ${DORIS_QUERY_TIMEOUT_S}`);
    });
    promisePool = base.promise();
  }
  return promisePool;
}

/**
 * Run a query against the app pool, retrying once if the pooled connection was dead
 * (server-side idle timeout / network reset). The retry runs on a fresh connection, so a
 * single stale handle no longer surfaces as a request error.
 */
export async function dorisQuery(sql: string, params: unknown[] = []) {
  try {
    return await dorisPool().query(sql, params);
  } catch (err) {
    if (!isFatalConnectionError(err)) throw err;
    // mysql2 has already evicted the dead connection; a retry acquires a healthy one.
    return await dorisPool().query(sql, params);
  }
}

export async function closeDorisPool(): Promise<void> {
  if (promisePool) {
    await promisePool.end();
    promisePool = undefined;
    base = undefined;
  }
}
