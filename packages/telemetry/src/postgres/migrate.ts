/**
 * Applies Postgres telemetry DDL migrations from infra/postgres-telemetry/*.sql in
 * filename order, tracked in a `telemetry.schema_migrations` ledger so each file runs
 * at most once per deployment.
 *
 * Unlike the Doris runner there is NO `;` statement splitting — files may contain
 * `$fn$`-quoted function bodies that a naive splitter would sever. node-pg's simple
 * query protocol (query without params) accepts multi-statement strings, and each file
 * runs inside one transaction: PG DDL is transactional, so a half-applied file rolls
 * back cleanly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPool, pgTelemetryConfig } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "infra", "postgres-telemetry");

const BOOT_ATTEMPTS = 10;
const BOOT_DELAY_MS = 2_000;

/** Short connect retry — PG has no BE-registration phase, it's just container start. */
async function withBootRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < BOOT_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  waiting for postgres (${what}): ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, BOOT_DELAY_MS));
    }
  }
  throw lastErr;
}

export async function migratePostgres(): Promise<void> {
  const { schema } = pgTelemetryConfig();
  const pool = createPgPool();

  // Bootstrap: schema + extension + ledger. pgvector >= 0.7 is a trusted extension —
  // installable by the database owner when the shared library is present in the image.
  await withBootRetry("create schema", () => pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`));
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `pgvector extension unavailable (${msg.slice(0, 120)}) — the postgres telemetry engine requires a ` +
        "pgvector-enabled image (e.g. pgvector/pgvector:pg16)",
    );
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const appliedRows = await pool.query(`SELECT name FROM ${schema}.schema_migrations`);
  const applied = new Set((appliedRows.rows as { name: string }[]).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`→ ${file} already applied`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`→ applying ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Simple query protocol: the whole file as one multi-statement query.
      await client.query(sql);
      await client.query(`INSERT INTO ${schema}.schema_migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  console.log("Telemetry migrations applied (postgres).");
  await pool.end();
}
