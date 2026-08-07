import type { TelemetryStore } from "./store.js";
import type { ScanCursor, TelemetryRowMap, TelemetryTable } from "./types.js";
import { TELEMETRY_PRIMARY_KEYS } from "./types.js";

/**
 * Engine-to-engine copy + verification (ADR-0004 graduation path). Everything here is
 * driven through TelemetryStore seam methods only — no engine SQL — so it works for any
 * source/target pair and inherits the conformance suite's guarantees. The CLI wrapper
 * (`scripts/telemetry-migrate.ts`, `bun run telemetry:migrate`) is a thin driver over
 * these functions.
 */

/** All telemetry tables, in copy order (parents before children is not required — rows are
 *  independent under LWW — but keeping traces first makes progress output read naturally). */
export const COPY_TABLES = Object.keys(TELEMETRY_PRIMARY_KEYS) as TelemetryTable[];

export interface CopyProgress {
  table: TelemetryTable;
  pages: number;
  rows: number;
}

export interface CopyResult {
  table: TelemetryTable;
  rows: number;
  pages: number;
}

/**
 * Reservoir sampler (Algorithm R): keeps a uniform random sample of up to `capacity`
 * items from a stream of unknown length, in O(capacity) memory. Used to collect
 * spot-check ids while the copy streams past every row anyway.
 */
export class Reservoir<T> {
  private items: T[] = [];
  private seen = 0;
  constructor(private capacity: number) {}
  offer(item: T): void {
    this.seen++;
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.capacity) this.items[j] = item;
    }
  }
  sample(): T[] {
    return [...this.items];
  }
}

/** Spot-check ids collected during a scan, keyed by project. */
export interface SpotCheckSamples {
  traceIds: Map<string, Reservoir<string>>;
  observationIds: Map<string, Reservoir<string>>;
}

export function newSamples(): SpotCheckSamples {
  return { traceIds: new Map(), observationIds: new Map() };
}

function offerSample(map: Map<string, Reservoir<string>>, projectId: string, id: string, capacity: number): void {
  let r = map.get(projectId);
  if (!r) {
    r = new Reservoir<string>(capacity);
    map.set(projectId, r);
  }
  r.offer(id);
}

export interface CopyTableOptions {
  batchSize?: number;
  /** Scan + count only; no writes to the target. */
  dryRun?: boolean;
  /** Called after each page lands (or is counted, under dryRun). */
  onProgress?: (p: CopyProgress) => void;
  /** When set, trace/observation ids are reservoir-sampled into it during the scan. */
  samples?: SpotCheckSamples;
  /** Per-project sample capacity (default 20). */
  sampleCapacity?: number;
}

/**
 * Copy one table source → target by paging `scanRows` into `insertRows`. Rows carry their
 * LWW sequence value (`event_ts`), so the copy is idempotent and resumable: re-running
 * converges, and overlap with live ingest can never regress a newer row on the target.
 */
export async function copyTable<T extends TelemetryTable>(
  source: TelemetryStore,
  target: TelemetryStore,
  table: T,
  opts: CopyTableOptions = {},
): Promise<CopyResult> {
  const batchSize = opts.batchSize ?? 1000;
  const capacity = opts.sampleCapacity ?? 20;
  let cursor: ScanCursor | undefined;
  let rows = 0;
  let pages = 0;

  for (;;) {
    const page = await source.scanRows(table, cursor, batchSize);
    if (page.rows.length > 0) {
      if (!opts.dryRun) await target.insertRows(table, page.rows);
      rows += page.rows.length;
      pages++;
      if (opts.samples) {
        for (const row of page.rows) {
          const r = row as unknown as Record<string, unknown>;
          if (table === "traces") offerSample(opts.samples.traceIds, String(r.project_id), String(r.id), capacity);
          else if (table === "observations")
            offerSample(opts.samples.observationIds, String(r.project_id), String(r.id), capacity);
        }
      }
      opts.onProgress?.({ table, pages, rows });
    }
    if (!page.next) break;
    cursor = page.next;
  }

  return { table, rows, pages };
}

// ── Verification ─────────────────────────────────────────────────────────────────

export interface CountMismatch {
  projectId: string;
  table: "traces" | "observations" | "scores";
  source: number;
  target: number;
}

/** Compare per-project row counts on both engines. Empty result = counts agree. */
export async function verifyCounts(
  source: TelemetryStore,
  target: TelemetryStore,
  projectIds: string[],
): Promise<CountMismatch[]> {
  const mismatches: CountMismatch[] = [];
  for (const projectId of projectIds) {
    const [s, t] = await Promise.all([source.countProjectRows(projectId), target.countProjectRows(projectId)]);
    for (const table of ["traces", "observations", "scores"] as const) {
      if (s[table] !== t[table]) mismatches.push({ projectId, table, source: s[table], target: t[table] });
    }
  }
  return mismatches;
}

export interface RowMismatch {
  projectId: string;
  kind: "trace" | "observation";
  id: string;
  /** First differing field, or "missing-on-target" / "missing-on-source". */
  field: string;
  source?: unknown;
  target?: unknown;
}

const asRecords = (rows: object[]): Record<string, unknown>[] => rows as unknown as Record<string, unknown>[];

/** ISO datetime shape — used to normalize engine-specific fractional-second padding. */
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Stable stringify (sorted keys), with ISO datetimes normalized to millisecond precision —
 * the engines legally render the same instant differently (Doris pads to microseconds,
 * `…57.901000Z`; Postgres emits milliseconds, `…57.901Z`), and the LWW contract only
 * guarantees ms fidelity, so equality is compared at ms precision.
 */
function canonical(v: unknown): string {
  const normalize = (val: unknown): unknown =>
    typeof val === "string" && ISO_TS_RE.test(val) ? new Date(val).toISOString() : val;
  return JSON.stringify(normalize(v), (_k, val) => {
    const n = normalize(val);
    return n && typeof n === "object" && !Array.isArray(n)
      ? Object.fromEntries(
          Object.entries(n as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : n;
  });
}

function diffRows(
  projectId: string,
  kind: "trace" | "observation",
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
  wantedIds: string[],
): RowMismatch[] {
  const out: RowMismatch[] = [];
  const byIdSource = new Map(sourceRows.map((r) => [String(r.id), r]));
  const byIdTarget = new Map(targetRows.map((r) => [String(r.id), r]));
  for (const id of wantedIds) {
    const s = byIdSource.get(id);
    const t = byIdTarget.get(id);
    if (s && !t) {
      out.push({ projectId, kind, id, field: "missing-on-target" });
      continue;
    }
    if (!s && t) {
      out.push({ projectId, kind, id, field: "missing-on-source" });
      continue;
    }
    if (!s || !t) continue; // sampled id vanished on both (e.g. retention) — not a copy defect
    for (const field of new Set([...Object.keys(s), ...Object.keys(t)])) {
      if (canonical(s[field]) !== canonical(t[field])) {
        out.push({ projectId, kind, id, field, source: s[field], target: t[field] });
        break; // first differing field per row is enough to act on
      }
    }
  }
  return out;
}

/**
 * Row-level spot check: fetch each sampled trace/observation id from BOTH engines via the
 * write-shaped read-back methods and compare field-by-field. Empty result = rows identical.
 */
export async function verifyRows(
  source: TelemetryStore,
  target: TelemetryStore,
  samples: SpotCheckSamples,
): Promise<RowMismatch[]> {
  const mismatches: RowMismatch[] = [];
  for (const [projectId, reservoir] of samples.traceIds) {
    const ids = reservoir.sample();
    if (ids.length === 0) continue;
    const [s, t] = await Promise.all([
      source.getTraceRowsByIds(projectId, ids),
      target.getTraceRowsByIds(projectId, ids),
    ]);
    mismatches.push(...diffRows(projectId, "trace", asRecords(s), asRecords(t), ids));
  }
  for (const [projectId, reservoir] of samples.observationIds) {
    const ids = reservoir.sample();
    if (ids.length === 0) continue;
    const [s, t] = await Promise.all([
      source.getObservationRowsByIds(projectId, ids),
      target.getObservationRowsByIds(projectId, ids),
    ]);
    mismatches.push(...diffRows(projectId, "observation", asRecords(s), asRecords(t), ids));
  }
  return mismatches;
}

/** Sample ids by scanning (for --verify-only runs, where no copy pass collects them). */
export async function collectSamples(
  source: TelemetryStore,
  opts: { batchSize?: number; sampleCapacity?: number } = {},
): Promise<SpotCheckSamples> {
  const samples = newSamples();
  for (const table of ["traces", "observations"] as const) {
    await copyTable(source, source, table, {
      batchSize: opts.batchSize,
      dryRun: true, // scan only — the "target" is never written
      samples,
      sampleCapacity: opts.sampleCapacity,
    });
  }
  return samples;
}
