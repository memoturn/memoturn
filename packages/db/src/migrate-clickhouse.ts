/**
 * Applies ClickHouse DDL migrations from infra/clickhouse/*.sql in filename order.
 * Statements are split on `;` at end-of-line. Idempotent (DDL uses IF NOT EXISTS).
 *
 * Run with: pnpm db:clickhouse
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clickhouse } from "./clickhouse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "infra", "clickhouse");

async function main() {
  const ch = clickhouse();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No ClickHouse migrations found in", MIGRATIONS_DIR);
    return;
  }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Strip `--` line comments first so comment-led statements aren't dropped,
    // then split into individual statements on `;`.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`→ applying ${file} (${statements.length} statements)`);
    for (const statement of statements) {
      await ch.command({ query: statement });
    }
  }

  console.log("ClickHouse migrations applied.");
  await ch.close();
}

main().catch((err) => {
  console.error("ClickHouse migration failed:", err);
  process.exit(1);
});
