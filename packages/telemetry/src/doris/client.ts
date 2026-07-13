import mysql from "mysql2";
import type { Pool } from "mysql2/promise";

/**
 * Shared Doris connection pool (MySQL protocol against the FE). Sessions are pinned to
 * UTC so DATETIME comparisons and NOW() match the ISO-8601 UTC timestamps memoturn
 * writes. `dateStrings` keeps DATETIME values as strings — timestamps are formatted in
 * SQL, never converted through JS Date.
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

/** Create a standalone pool (used by the migration runner, which manages the database). */
export function createDorisPool(config: Partial<DorisConfig> = {}): Pool {
  const pool = mysql.createPool({
    ...dorisConfig(),
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true,
    multipleStatements: false,
  });
  pool.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));
  return pool.promise();
}

export function dorisPool(): Pool {
  if (!promisePool) {
    base = mysql.createPool({
      ...dorisConfig(),
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
      multipleStatements: false,
    });
    base.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));
    promisePool = base.promise();
  }
  return promisePool;
}

export async function closeDorisPool(): Promise<void> {
  if (promisePool) {
    await promisePool.end();
    promisePool = undefined;
    base = undefined;
  }
}
