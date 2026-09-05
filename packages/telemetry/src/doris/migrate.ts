/**
 * Applies Doris DDL migrations from infra/doris/*.sql in filename order, tracked in a
 * `schema_migrations` ledger table so each file runs at most once per deployment.
 *
 * Hardening (see docs/deployment.md#migrations):
 *  - Boot retry is scoped to connection / no-alive-BE errors. A genuinely bad statement
 *    fails immediately instead of spinning 30 × 3 s per statement.
 *  - `ALTER TABLE … ADD COLUMN` is made idempotent by checking information_schema first
 *    (Doris 4.x has no ADD COLUMN IF NOT EXISTS), so a file that failed halfway can be
 *    re-run safely — the ledger row is only written once every statement succeeded.
 *  - Every statement logs its index so a half-applied file is diagnosable from the log.
 *  - `${REPLICATION_NUM}` in a file is substituted from DORIS_REPLICATION_NUM (default 1);
 *    the historic files hard-code "1" and are fixed up post-hoc by `telemetry:repartition
 *    --set-replication`.
 *  - Single runner by design: compose runs the migrate service once (service_completed_
 *    successfully gates api/worker); the Helm Job is parallelism 1. Doris DDL is not
 *    transactional, so two concurrent runners cannot be made safe from here.
 *
 * Bootstraps the database itself (CREATE DATABASE IF NOT EXISTS) and retries while the
 * cluster warms up — the FE answers queries before the first BE has registered, and
 * DDL fails until a BE is alive.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDorisPool, dorisConfig, envInt, isFatalConnectionError, REPLICATION_NUM } from "./client.js";
import { ALL_TABLES, createTableDdl, PARTITIONED_TABLES } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "infra", "doris");

const BOOT_ATTEMPTS = 30;
const BOOT_DELAY_MS = 3_000;

export { REPLICATION_NUM };

/** Errors that mean "the cluster isn't ready yet" (worth waiting for), not "this DDL is wrong". */
export function isBootError(err: unknown): boolean {
  if (isFatalConnectionError(err)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /econnrefused|enotfound|ehostunreach|etimedout|connect timeout/.test(msg) ||
    /no available be|no alive be|backend.*not alive|not enough backend|failed to find enough (backend|host)/.test(
      msg,
    ) ||
    /replication num should be less than the number of available backends/.test(msg) ||
    /the master fe is (not )?ready|not ready yet|frontend.*not ready|is not master/.test(msg)
  );
}

/** Retry `fn` while the cluster is still warming up; rethrow anything else immediately. */
async function withBootRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < BOOT_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBootError(err)) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  waiting for doris (${what}): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, BOOT_DELAY_MS));
    }
  }
  throw lastErr;
}

export function splitStatements(sql: string): string[] {
  // Strip `--` line comments first so comment-led statements aren't dropped,
  // then split into individual statements on `;`.
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The token new DDL files use for replication (built by concatenation so it is not a template literal). */
export const REPLICATION_PLACEHOLDER = ["$", "{REPLICATION_NUM}"].join("");

/** Substitute the replication placeholder (future files) — historic files keep their literal "1". */
export function renderStatement(statement: string, replicationNum = REPLICATION_NUM): string {
  return statement.replaceAll(REPLICATION_PLACEHOLDER, String(replicationNum));
}

/** `ALTER TABLE t ADD COLUMN c …` → { table, column }, else null. */
export function parseAddColumn(statement: string): { table: string; column: string } | null {
  const m = /^ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+COLUMN\s+`?(\w+)`?/i.exec(statement.trim());
  return m ? { table: (m[1] as string).toLowerCase(), column: (m[2] as string).toLowerCase() } : null;
}

type Querier = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

async function columnExists(pool: Querier, database: string, table: string, column: string): Promise<boolean> {
  const [rows] = (await pool.query(
    "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1",
    [database, table, column],
  )) as [unknown[]];
  return rows.length > 0;
}

/** Retention ceiling in days (TELEMETRY_MAX_RETENTION_DAYS, 0 = unset) → partition.retention_count. */
export function retentionCountFromEnv(): number {
  return envInt("TELEMETRY_MAX_RETENTION_DAYS", 0, 0);
}

export interface TableShape {
  table: string;
  partitioned: boolean;
  replication: number | null;
  retentionCount: number | null;
}

/** Inspect a table's physical shape via SHOW CREATE TABLE (partitioning, replication, TTL). */
export async function inspectTable(pool: Querier, table: string): Promise<TableShape | null> {
  let rows: { "Create Table": string }[];
  try {
    [rows] = (await pool.query(`SHOW CREATE TABLE ${table}`)) as [{ "Create Table": string }[]];
  } catch {
    return null;
  }
  const ddl = rows[0]?.["Create Table"] ?? "";
  const rep = /"replication_allocation"\s*=\s*"tag\.location\.default:\s*(\d+)"/.exec(ddl);
  const ret = /"partition\.retention_count"\s*=\s*"(\d+)"/.exec(ddl);
  return {
    table,
    partitioned: /\bPARTITION BY\b/i.test(ddl),
    replication: rep ? Number(rep[1]) : null,
    retentionCount: ret ? Number(ret[1]) : null,
  };
}

/**
 * Post-migration checks. Never fails the boot: an unpartitioned table is a performance and
 * retention concern, not a correctness one — but say so loudly, every deploy, until fixed.
 */
export async function reportShape(pool: Querier): Promise<TableShape[]> {
  const shapes: TableShape[] = [];
  for (const table of ALL_TABLES) {
    const shape = await inspectTable(pool, table);
    if (!shape) continue;
    shapes.push(shape);
    if ((PARTITIONED_TABLES as readonly string[]).includes(table) && !shape.partitioned) {
      console.warn(
        `⚠ ${table} is UNPARTITIONED (legacy schema): time-range queries scan the whole table and retention ` +
          "is a full-table DELETE. Convert it with `bun run telemetry:repartition` (docs/deployment.md#repartitioning).",
      );
    }
    if (shape.replication !== null && shape.replication !== REPLICATION_NUM) {
      console.warn(
        `⚠ ${table} has replication_num=${shape.replication} but DORIS_REPLICATION_NUM=${REPLICATION_NUM}; ` +
          "apply with `bun run telemetry:repartition -- --set-replication N`.",
      );
    }
  }
  return shapes;
}

/** Keep partition.retention_count on the partitioned tables in step with TELEMETRY_MAX_RETENTION_DAYS. */
export async function syncPartitionRetention(pool: Querier, shapes: TableShape[]): Promise<void> {
  const want = retentionCountFromEnv();
  for (const shape of shapes) {
    if (!shape.partitioned || !(PARTITIONED_TABLES as readonly string[]).includes(shape.table)) continue;
    const have = shape.retentionCount ?? 0;
    if (want === have) continue;
    // Doris has no "unset" for this property; a large count is effectively "keep everything".
    const value = want > 0 ? String(want) : "1000000";
    await pool.query(`ALTER TABLE ${shape.table} SET ("partition.retention_count" = "${value}")`);
    console.log(`→ ${shape.table}: partition.retention_count ${have || "unset"} → ${want > 0 ? want : "unset"}`);
  }
}

export async function migrateDoris(): Promise<void> {
  const { database } = dorisConfig();
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error(`invalid DORIS_DB name: ${database}`);
  }

  // Bootstrap the database with a database-less connection, then reconnect into it.
  const bootstrap = createDorisPool({ database: "information_schema" });
  await withBootRetry("create database", () => bootstrap.query(`CREATE DATABASE IF NOT EXISTS ${database}`));
  await bootstrap.end();

  const pool = createDorisPool();
  await withBootRetry("create ledger", () =>
    pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name VARCHAR(255) NOT NULL,
         applied_at DATETIME NOT NULL
       )
       UNIQUE KEY(name)
       DISTRIBUTED BY HASH(name) BUCKETS 1
       PROPERTIES ("replication_num" = "${REPLICATION_NUM}")`,
    ),
  );

  // Step 0: canonical (partitioned) tables for fresh installs. `IF NOT EXISTS` makes this a
  // no-op on an existing install, whose legacy tables are converted by the repartition CLI.
  for (const table of ALL_TABLES) {
    await withBootRetry(`create ${table}`, () =>
      pool.query(createTableDdl(table, { retentionCount: retentionCountFromEnv() })),
    );
  }

  const [appliedRows] = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set((appliedRows as { name: string }[]).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`→ ${file} already applied`);
      continue;
    }
    const statements = splitStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8")).map((s) => renderStatement(s));
    console.log(`→ applying ${file} (${statements.length} statements)`);
    for (const [i, statement] of statements.entries()) {
      const add = parseAddColumn(statement);
      if (add && (await columnExists(pool, database, add.table, add.column))) {
        console.log(`  [${i + 1}/${statements.length}] skip — ${add.table}.${add.column} already exists`);
        continue;
      }
      try {
        await withBootRetry(`${file} #${i + 1}`, () => pool.query(statement));
      } catch (err) {
        console.error(
          `  [${i + 1}/${statements.length}] FAILED in ${file}: ${err instanceof Error ? err.message : String(err)}\n` +
            "  The file is NOT recorded as applied; earlier statements in it have taken effect. " +
            "Re-running is safe for ADD COLUMN statements (skipped when present); inspect others by hand.",
        );
        throw err;
      }
      console.log(`  [${i + 1}/${statements.length}] ok`);
    }
    await pool.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW())", [file]);
  }

  const shapes = await reportShape(pool);
  await syncPartitionRetention(pool, shapes);

  console.log("Telemetry migrations applied (doris).");
  await pool.end();
}
