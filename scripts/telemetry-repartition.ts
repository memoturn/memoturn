/**
 * Convert an existing Doris install's UNPARTITIONED telemetry tables (created by the
 * historic infra/doris/0001 DDL) to the canonical AUTO PARTITION layout, and manage
 * replication. Fresh installs never need this — the migrator creates partitioned tables.
 *
 *   bun run telemetry:repartition -- --plan                 # what would change (no writes)
 *   bun run telemetry:repartition                            # convert every unpartitioned table
 *   bun run telemetry:repartition -- --tables traces,scores  # a subset
 *   bun run telemetry:repartition -- --cleanup               # drop the retained <t>__legacy copies
 *   bun run telemetry:repartition -- --set-replication 3     # replication_num on every table + ledger
 *
 * Per table the conversion is: create `<t>__v2` from the canonical DDL (retention unset so
 * backfilled history isn't dropped mid-run) → `INSERT INTO <t>__v2 SELECT … FROM <t>`
 * chunked by month → verify per-project row counts on both → `ALTER TABLE <t> REPLACE WITH
 * TABLE <t>__v2` (atomic; the old table survives as `<t>__legacy`… i.e. under the __v2 name
 * with swap=true, renamed here for clarity) → apply partition.retention_count.
 *
 * Choreography (docs/deployment.md#repartitioning): run once live (bulk), PAUSE THE WORKER,
 * run again (fast top-up — every insert is LWW-idempotent, so overlap is harmless), let it
 * swap, resume the worker. Disk temporarily doubles for the table being converted.
 */
import {
  ALL_TABLES,
  columnList,
  createDorisPool,
  createTableDdl,
  dorisConfig,
  inspectTable,
  PARTITION_COLUMN,
  PARTITIONED_TABLES,
  REPLICATION_NUM,
  retentionCountFromEnv,
} from "@memoturn/telemetry";

type Table = (typeof PARTITIONED_TABLES)[number];
type Pool = ReturnType<typeof createDorisPool>;

function parseArgs(argv: string[]) {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tables = (
    opt("tables")
      ?.split(",")
      .map((t) => t.trim()) ?? [...PARTITIONED_TABLES]
  ).filter((t) => (PARTITIONED_TABLES as readonly string[]).includes(t)) as Table[];
  const rep = opt("set-replication");
  return {
    plan: argv.includes("--plan"),
    cleanup: argv.includes("--cleanup"),
    tables,
    setReplication: rep !== undefined ? Number(rep) : undefined,
  };
}

async function rows<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await pool.query(sql, params);
  return r as T[];
}

async function countsByProject(pool: Pool, table: string): Promise<Map<string, number>> {
  const r = await rows<{ project_id: string; n: number | string }>(
    pool,
    `SELECT project_id, COUNT(*) AS n FROM ${table} GROUP BY project_id`,
  );
  return new Map(r.map((x) => [x.project_id, Number(x.n)]));
}

/** Month boundaries spanning the table's time column, so each INSERT…SELECT is bounded. */
async function monthChunks(pool: Pool, table: Table): Promise<[string, string][]> {
  const col = PARTITION_COLUMN[table];
  const [r] = await rows<{ lo: string | null; hi: string | null }>(
    pool,
    `SELECT MIN(${col}) AS lo, MAX(${col}) AS hi FROM ${table}`,
  );
  if (!r?.lo || !r.hi) return [];
  const chunks: [string, string][] = [];
  const start = new Date(r.lo);
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const end = new Date(r.hi);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  while (cur <= end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    chunks.push([fmt(cur), fmt(next)]);
    cur = next;
  }
  return chunks;
}

async function convert(pool: Pool, table: Table, plan: boolean): Promise<void> {
  const shape = await inspectTable(pool, table);
  if (!shape) {
    console.log(`  ${table}: not present — skip`);
    return;
  }
  if (shape.partitioned) {
    console.log(`  ${table}: already partitioned ✓`);
    return;
  }
  const total = [...(await countsByProject(pool, table)).values()].reduce((a, b) => a + b, 0);
  console.log(`  ${table}: UNPARTITIONED, ${total} row(s) → convert`);
  if (plan) return;

  const v2 = `${table}__v2`;
  const col = PARTITION_COLUMN[table];
  const cols = columnList(table).join(", ");
  await pool.query(createTableDdl(table, { name: v2, retentionCount: 0 }));

  const chunks = await monthChunks(pool, table);
  let copied = 0;
  for (const [lo, hi] of chunks) {
    await pool.query(`INSERT INTO ${v2} (${cols}) SELECT ${cols} FROM ${table} WHERE ${col} >= ? AND ${col} < ?`, [
      lo,
      hi,
    ]);
    const [c] = await rows<{ n: number | string }>(
      pool,
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} >= ? AND ${col} < ?`,
      [lo, hi],
    );
    copied += Number(c?.n ?? 0);
    console.log(`    ${lo.slice(0, 7)}: ${Number(c?.n ?? 0)} row(s) (${copied}/${total})`);
  }

  // Verify per-project counts before the swap; refuse on any mismatch.
  const [src, dst] = await Promise.all([countsByProject(pool, table), countsByProject(pool, v2)]);
  const mismatches: string[] = [];
  for (const [p, n] of src) if ((dst.get(p) ?? 0) !== n) mismatches.push(`${p}: ${n} vs ${dst.get(p) ?? 0}`);
  if (mismatches.length) {
    console.error(`  ${table}: count mismatch, NOT swapping (re-run to top up):\n    ${mismatches.join("\n    ")}`);
    process.exitCode = 1;
    return;
  }

  // Atomic swap; the legacy table is kept under the __v2 name (swap=true) until --cleanup.
  await pool.query(`ALTER TABLE ${table} REPLACE WITH TABLE ${v2} PROPERTIES("swap" = "true")`);
  const want = retentionCountFromEnv();
  if (want > 0) await pool.query(`ALTER TABLE ${table} SET ("partition.retention_count" = "${want}")`);
  console.log(`  ${table}: swapped ✓ (legacy copy retained as ${v2}; drop it with --cleanup once satisfied)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = dorisConfig();
  const pool = createDorisPool();
  console.log(
    `Doris ${cfg.host}:${cfg.port}/${cfg.database} — replication target ${REPLICATION_NUM}, retention ceiling ${retentionCountFromEnv() || "unset"}`,
  );

  if (args.setReplication !== undefined) {
    const n = args.setReplication;
    if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("--set-replication must be 1..9");
    for (const table of [...ALL_TABLES, "schema_migrations"]) {
      if (!(await inspectTable(pool, table))) continue;
      if (args.plan) {
        console.log(`  ${table}: would set replication_num=${n}`);
        continue;
      }
      await pool.query(`ALTER TABLE ${table} MODIFY PARTITION (*) SET ("replication_num" = "${n}")`);
      await pool.query(`ALTER TABLE ${table} SET ("default.replication_num" = "${n}")`);
      console.log(`  ${table}: replication_num=${n} ✓`);
    }
    await pool.end();
    return;
  }

  if (args.cleanup) {
    for (const table of PARTITIONED_TABLES) {
      const legacy = await inspectTable(pool, `${table}__v2`);
      if (!legacy) continue;
      if (args.plan) {
        console.log(`  would DROP ${table}__v2 (legacy copy)`);
        continue;
      }
      await pool.query(`DROP TABLE ${table}__v2`);
      console.log(`  dropped ${table}__v2 ✓`);
    }
    await pool.end();
    return;
  }

  console.log(args.plan ? "Plan:" : "Converting:");
  for (const table of args.tables) await convert(pool, table, args.plan);
  await pool.end();
  if (args.plan) console.log("(no changes made)");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("repartition failed:", err);
    process.exit(1);
  });
