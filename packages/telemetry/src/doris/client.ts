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
    connectionLimit: 10,
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
  pool.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));
  return pool.promise();
}

export function dorisPool(): Pool {
  if (!promisePool) {
    base = mysql.createPool(poolOptions());
    base.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));
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
