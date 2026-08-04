import { prisma } from "@memoturn/db";
import {
  COPY_TABLES,
  collectSamples,
  copyTable,
  DorisTelemetryStore,
  newSamples,
  PostgresTelemetryStore,
  type TelemetryStore,
  type TelemetryTable,
  verifyCounts,
  verifyRows,
} from "@memoturn/telemetry";

/**
 * Engine-to-engine telemetry migration (ADR-0004 graduation path).
 *
 *   bun run telemetry:migrate -- --from postgres --to doris          # bulk copy + verify
 *   bun run telemetry:migrate -- --from postgres --to doris --dry-run    # count, no writes
 *   bun run telemetry:migrate -- --from postgres --to doris --verify-only # verify existing copy
 *
 * Flags: --tables t1,t2 (default: all), --batch N (default 1000), --spot-checks N (default 20).
 *
 * The copy pages `scanRows` from the source into `insertRows` on the target. Rows carry
 * their LWW sequence value, so the run is idempotent + resumable: re-running converges and
 * live-ingest overlap can never regress a row. Cutover choreography (ADR-0004): bulk copy
 * live → pause worker → re-run (top-up) → verify (this CLI refuses on mismatch) → flip
 * TELEMETRY_ENGINE → resume worker.
 *
 * Both engines' connection env must be set (DORIS_* and TELEMETRY_DATABASE_URL/DATABASE_URL);
 * `--from/--to` pick which is which. Direction doris→postgres (downsizing) warns above the
 * Postgres tier's sizing envelope.
 */

const ENGINES = { doris: DorisTelemetryStore, postgres: PostgresTelemetryStore } as const;
type Engine = keyof typeof ENGINES;

/** ADR-0002 sizes the Postgres tier at "tens of millions of telemetry rows and below". */
const PG_ENVELOPE_ROWS = 50_000_000;

function parseArgs(argv: string[]) {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const engine = (name: string): Engine => {
    const v = opt(name);
    if (v !== "doris" && v !== "postgres") {
      console.error(`error: --${name} must be "doris" or "postgres" (got: ${v ?? "nothing"})`);
      process.exit(2);
    }
    return v;
  };
  const from = engine("from");
  const to = engine("to");
  if (from === to) {
    console.error("error: --from and --to must differ");
    process.exit(2);
  }
  const tables = opt("tables")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tables ?? []) {
    if (!COPY_TABLES.includes(t as TelemetryTable)) {
      console.error(`error: unknown table "${t}" (valid: ${COPY_TABLES.join(", ")})`);
      process.exit(2);
    }
  }
  return {
    from,
    to,
    tables: (tables as TelemetryTable[] | undefined) ?? COPY_TABLES,
    batch: Number(opt("batch") ?? 1000),
    spotChecks: Number(opt("spot-checks") ?? 20),
    dryRun: flag("dry-run"),
    verifyOnly: flag("verify-only"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source: TelemetryStore = new ENGINES[args.from]();
  const target: TelemetryStore = new ENGINES[args.to]();
  // Engine pools + prisma hold the event loop open — always exit explicitly (see finally).
  cleanup = async () => {
    await Promise.allSettled([source.close(), target.close(), prisma.$disconnect()]);
  };

  for (const [label, store] of [
    [args.from, source],
    [args.to, target],
  ] as const) {
    if (!(await store.ping().catch(() => false))) {
      console.error(`error: ${label} store is not reachable — check its connection env`);
      process.exit(1);
    }
  }
  console.log(`engines reachable: ${args.from} (source) → ${args.to} (target)`);

  const projects = await prisma.project.findMany({ select: { id: true, name: true } });
  console.log(`projects: ${projects.length}`);

  // Downsizing guard: warn when the source likely exceeds the Postgres tier's envelope.
  if (args.to === "postgres") {
    let total = 0;
    for (const p of projects) {
      const c = await source.countProjectRows(p.id);
      total += c.traces + c.observations + c.scores;
    }
    if (total > PG_ENVELOPE_ROWS) {
      console.warn(
        `warning: source holds ~${total.toLocaleString()} rows — above the Postgres tier's sizing envelope ` +
          `(~${PG_ENVELOPE_ROWS.toLocaleString()}). The copy will run, but this install likely belongs on Doris (ADR-0002).`,
      );
    }
  }

  const samples = newSamples();

  if (!args.verifyOnly) {
    console.log(
      `\n${args.dryRun ? "dry run — counting" : "copying"} ${args.tables.length} table(s), batch ${args.batch}`,
    );
    const t0 = Date.now();
    for (const table of args.tables) {
      const result = await copyTable(source, target, table, {
        batchSize: args.batch,
        dryRun: args.dryRun,
        samples,
        sampleCapacity: args.spotChecks,
        onProgress: (p) => {
          if (p.pages % 20 === 0) console.log(`  ${table}: ${p.rows.toLocaleString()} rows…`);
        },
      });
      console.log(`  ${table}: ${result.rows.toLocaleString()} rows in ${result.pages} page(s)`);
    }
    console.log(`${args.dryRun ? "counted" : "copied"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (args.dryRun) return;
  }

  // ── Verify: per-project counts + row-level spot checks ─────────────────────────
  console.log("\nverifying…");
  const countMismatches = await verifyCounts(
    source,
    target,
    projects.map((p) => p.id),
  );
  const spot = samples.traceIds.size > 0 ? samples : await collectSamples(source, { sampleCapacity: args.spotChecks });
  const rowMismatches = await verifyRows(source, target, spot);

  for (const m of countMismatches) {
    console.error(`  COUNT MISMATCH project=${m.projectId} ${m.table}: source=${m.source} target=${m.target}`);
  }
  for (const m of rowMismatches) {
    console.error(
      `  ROW MISMATCH project=${m.projectId} ${m.kind}=${m.id} field=${m.field}` +
        (m.field.startsWith("missing") ? "" : ` source=${JSON.stringify(m.source)} target=${JSON.stringify(m.target)}`),
    );
  }

  const sampled = [...spot.traceIds.values(), ...spot.observationIds.values()].reduce(
    (n, r) => n + r.sample().length,
    0,
  );
  if (countMismatches.length > 0 || rowMismatches.length > 0) {
    console.error(
      `\n✗ verification FAILED (${countMismatches.length} count, ${rowMismatches.length} row mismatch(es)). ` +
        "Do not flip TELEMETRY_ENGINE. A re-run converges under LWW if the source changed mid-copy " +
        "(pause the worker for the top-up pass, per the ADR-0004 runbook).",
    );
    process.exit(1);
  }
  console.log(`✓ verified: counts match across ${projects.length} project(s); ${sampled} spot-checked rows identical.`);
  console.log(
    "\nnext (ADR-0004 runbook): pause the worker → re-run this migration (fast LWW top-up) → " +
      `re-verify → set TELEMETRY_ENGINE=${args.to} on api+worker → resume the worker.`,
  );
}

let cleanup: (() => Promise<unknown>) | undefined;

main()
  .then(async () => {
    await cleanup?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("fatal:", err instanceof Error ? err.message : err);
    await cleanup?.();
    process.exit(1);
  });
