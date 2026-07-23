/**
 * Applies Doris DDL migrations from infra/doris/*.sql in filename order, tracked in a
 * `schema_migrations` ledger table so each file runs at most once per deployment
 * (files may contain non-idempotent ALTERs). Statements are split on `;`.
 *
 * Bootstraps the database itself (CREATE DATABASE IF NOT EXISTS) and retries while the
 * cluster warms up — the FE answers queries before the first BE has registered, and
 * DDL fails until a BE is alive.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDorisPool, dorisConfig } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "infra", "doris");

const BOOT_ATTEMPTS = 30;
const BOOT_DELAY_MS = 3_000;

/** Retry `fn` while the cluster is still warming up (no alive BE yet, FE restarting…). */
async function withBootRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < BOOT_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  waiting for doris (${what}): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, BOOT_DELAY_MS));
    }
  }
  throw lastErr;
}

function splitStatements(sql: string): string[] {
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
       PROPERTIES ("replication_num" = "1")`,
    ),
  );

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
    const statements = splitStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    console.log(`→ applying ${file} (${statements.length} statements)`);
    for (const statement of statements) {
      await withBootRetry(file, () => pool.query(statement));
    }
    await pool.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW())", [file]);
  }

  console.log("Telemetry migrations applied (doris).");
  await pool.end();
}
