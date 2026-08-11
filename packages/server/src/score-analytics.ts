import type {
  ScoreAgreement,
  ScoreDistribution,
  ScoreHistogramBucket,
  ScoreMatrixCell,
  ScoreNameInfo,
} from "@memoturn/contracts";
import { type ScorePairRow, telemetry } from "@memoturn/telemetry";

/**
 * Score analytics — the surface that answers "is this score trustworthy?".
 *
 * Two halves. **Distribution** describes one score: how its values spread, how they move over
 * time, summary statistics. **Agreement** compares two score *sources* over the traces that
 * carry both — human vs judge, judge vs judge, v1 vs v2 of a judge — which is how a team
 * establishes that a judge can be relied on, and it subsumes the narrower "inter-rater
 * agreement on review queues" idea.
 *
 * The engine does the grouping; the statistics are computed here from the paired rows, so a
 * new engine never has to reimplement Kappa in SQL.
 */

/** Buckets in a numeric distribution histogram, and on each axis of a numeric confusion matrix. */
const HISTOGRAM_BUCKETS = 10;
const MATRIX_BUCKETS = 5;

/**
 * Cap on the paired rows an agreement query scans. This join is the widest query in the
 * product; past this size the statistics are computed over a sample, and `sampled` says so.
 */
export const AGREEMENT_PAIR_CAP = 20_000;

/** Round to 4 decimals — these are display statistics, not accounting. */
const r4 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : 0);

/**
 * The score names available to analyse, one row per name. A name written by more than one
 * source (a judge and a human annotating the same dimension) collapses to its most common
 * data type, with the counts summed — the picker cares about the name.
 */
export async function listScoreNames(projectId: string, days = 30): Promise<ScoreNameInfo[]> {
  const rows = await telemetry().listScoreNames(projectId, days);
  const byName = new Map<string, ScoreNameInfo & { top: number }>();
  for (const r of rows) {
    const cur = byName.get(r.name);
    if (!cur) {
      byName.set(r.name, { name: r.name, dataType: r.data_type, source: r.source, count: r.count, top: r.count });
      continue;
    }
    cur.count += r.count;
    // Keep the data type / source of the most common variant, so a stray row can't relabel it.
    if (r.count > cur.top) {
      cur.top = r.count;
      cur.dataType = r.data_type;
      cur.source = r.source;
    }
  }
  return [...byName.values()]
    .map(({ top: _top, ...info }) => info)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Equal-width buckets across the observed range, with empty buckets kept (a gap is a signal). */
function buildHistogram(
  raw: { bucket: number; count: number }[],
  min: number,
  width: number,
  buckets: number,
): ScoreHistogramBucket[] {
  const counts = new Array<number>(buckets).fill(0);
  for (const r of raw) {
    // The maximum value lands one past the last bucket; it belongs in the last one.
    const i = Math.min(Math.max(0, Math.floor(r.bucket)), buckets - 1);
    counts[i] = (counts[i] ?? 0) + r.count;
  }
  return counts.map((count, i) => ({ from: r4(min + i * width), to: r4(min + (i + 1) * width), count }));
}

/** Everything the per-score surface shows: statistics, shape, and movement over time. */
export async function getScoreDistribution(projectId: string, name: string, days = 30): Promise<ScoreDistribution> {
  const store = telemetry();
  const [names, stats, categories, timeline] = await Promise.all([
    store.listScoreNames(projectId, days),
    store.scoreStats(projectId, name, days),
    store.scoreCategoryCounts(projectId, name, days),
    store.scoreTimeline(projectId, name, days),
  ]);
  const dataType = names.find((r) => r.name === name)?.data_type ?? (stats.count > 0 ? "NUMERIC" : "");

  // A histogram needs a range: a score whose values are all identical (or has none) gets no bars
  // rather than a fake one-bucket chart.
  let histogram: ScoreHistogramBucket[] = [];
  if (stats.count > 0 && stats.max > stats.min) {
    const width = (stats.max - stats.min) / HISTOGRAM_BUCKETS;
    const raw = await store.scoreHistogram(projectId, name, days, {
      min: stats.min,
      width,
      buckets: HISTOGRAM_BUCKETS,
    });
    histogram = buildHistogram(raw, stats.min, width, HISTOGRAM_BUCKETS);
  }

  return {
    name,
    dataType,
    days,
    stats: {
      count: stats.count,
      min: r4(stats.min),
      max: r4(stats.max),
      mean: r4(stats.mean),
      stddev: r4(stats.stddev),
      p50: r4(stats.p50),
      p95: r4(stats.p95),
    },
    histogram,
    categories,
    timeline: timeline.map((t) => ({ date: t.date, count: t.count, mean: r4(t.mean) })),
  };
}

/** Pearson correlation; 0 when either side is constant (undefined correlation, not 1). */
function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (xs[i] as number) - mx;
    const b = (ys[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/** Cohen's Kappa: agreement corrected for what chance alone would produce. */
function cohensKappa(pairs: { a: string; b: string }[]): number {
  const n = pairs.length;
  if (n === 0) return 0;
  const aCount = new Map<string, number>();
  const bCount = new Map<string, number>();
  let observed = 0;
  for (const p of pairs) {
    aCount.set(p.a, (aCount.get(p.a) ?? 0) + 1);
    bCount.set(p.b, (bCount.get(p.b) ?? 0) + 1);
    if (p.a === p.b) observed++;
  }
  const po = observed / n;
  let pe = 0;
  for (const [label, ca] of aCount) pe += (ca / n) * ((bCount.get(label) ?? 0) / n);
  // Perfect agreement with a single label everywhere: chance explains all of it → kappa 0.
  return pe >= 1 ? (po >= 1 ? 0 : -1) : (po - pe) / (1 - pe);
}

/** Per-label F1 of B treated as a prediction of A (the reference). */
function perLabelF1(pairs: { a: string; b: string }[]): { label: string; f1: number; support: number }[] {
  const labels = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort();
  return labels.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const p of pairs) {
      if (p.a === label) support++;
      if (p.b === label && p.a === label) tp++;
      else if (p.b === label) fp++;
      else if (p.a === label) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, f1: r4(f1), support };
  });
}

/** Bucket a numeric value into a labelled range, so numeric pairs get a confusion matrix too. */
function bucketLabel(value: number, min: number, width: number, buckets: number): string {
  const i = width === 0 ? 0 : Math.min(Math.max(0, Math.floor((value - min) / width)), buckets - 1);
  return `${r4(min + i * width)}–${r4(min + (i + 1) * width)}`;
}

/** Cell counts plus the axis label order, from label pairs. Nested maps rather than a joined
 *  key — labels are user data and may contain any separator character. */
function confusion(
  pairs: { a: string; b: string }[],
  order?: string[],
): { matrix: ScoreMatrixCell[]; labels: string[] } {
  const counts = new Map<string, Map<string, number>>();
  for (const p of pairs) {
    const row = counts.get(p.a) ?? new Map<string, number>();
    row.set(p.b, (row.get(p.b) ?? 0) + 1);
    counts.set(p.a, row);
  }
  const labels = order ?? [...new Set(pairs.flatMap((p) => [p.a, p.b]))].sort();
  const matrix: ScoreMatrixCell[] = [];
  for (const [a, row] of counts) for (const [b, count] of row) matrix.push({ a, b, count });
  return { matrix, labels };
}

/** True when a pair row has usable numbers on both sides. */
const bothNumeric = (p: ScorePairRow) => p.a_value != null && p.b_value != null;
/** True when a pair row has usable labels on both sides. */
const bothLabels = (p: ScorePairRow) => p.a_string !== "" && p.b_string !== "";

/**
 * Compare two score sources over the traces carrying both. Numeric pairs get correlation +
 * MAE/RMSE and a decile-bucketed heatmap; label pairs get agreement rate, Cohen's Kappa,
 * per-label F1, and a confusion matrix. A pair set that hits the scan cap is marked `sampled`
 * so a statistic over a sample is never read as one over everything.
 */
export async function getScoreAgreement(projectId: string, a: string, b: string, days = 30): Promise<ScoreAgreement> {
  const rows = await telemetry().scorePairs(projectId, a, b, days, AGREEMENT_PAIR_CAP);
  const base: ScoreAgreement = {
    a,
    b,
    days,
    pairs: rows.length,
    sampled: rows.length >= AGREEMENT_PAIR_CAP,
    numeric: null,
    categorical: null,
    matrix: [],
    aLabels: [],
    bLabels: [],
  };
  if (rows.length === 0) return base;

  // Prefer the numeric reading when both sides report numbers; labels otherwise. A mixed pair
  // (one numeric, one categorical) has no meaningful statistic, so it returns the count alone.
  const numericRows = rows.filter(bothNumeric);
  if (numericRows.length >= rows.length / 2) {
    const xs = numericRows.map((p) => p.a_value as number);
    const ys = numericRows.map((p) => p.b_value as number);
    const n = xs.length;
    let absSum = 0;
    let sqSum = 0;
    for (let i = 0; i < n; i++) {
      const d = (xs[i] as number) - (ys[i] as number);
      absSum += Math.abs(d);
      sqSum += d * d;
    }
    const min = Math.min(...xs, ...ys);
    const max = Math.max(...xs, ...ys);
    const width = max > min ? (max - min) / MATRIX_BUCKETS : 0;
    const labelled = numericRows.map((p) => ({
      a: bucketLabel(p.a_value as number, min, width, MATRIX_BUCKETS),
      b: bucketLabel(p.b_value as number, min, width, MATRIX_BUCKETS),
    }));
    // Fixed axis order for numeric buckets: ascending ranges, not lexicographic label order.
    // A constant score has no range, so it gets the single bucket its values actually fall in.
    const order =
      width === 0
        ? [bucketLabel(min, min, width, MATRIX_BUCKETS)]
        : Array.from({ length: MATRIX_BUCKETS }, (_, i) =>
            bucketLabel(min + i * width + width / 2, min, width, MATRIX_BUCKETS),
          );
    const { matrix } = confusion(labelled, order);
    return {
      ...base,
      numeric: { correlation: r4(correlation(xs, ys)), mae: r4(absSum / n), rmse: r4(Math.sqrt(sqSum / n)) },
      matrix,
      aLabels: order,
      bLabels: order,
    };
  }

  const labelRows = rows.filter(bothLabels).map((p) => ({ a: p.a_string, b: p.b_string }));
  if (labelRows.length === 0) return base;
  const agreed = labelRows.filter((p) => p.a === p.b).length;
  const { matrix, labels } = confusion(labelRows);
  return {
    ...base,
    categorical: {
      agreementRate: r4(agreed / labelRows.length),
      cohensKappa: r4(cohensKappa(labelRows)),
      f1: perLabelF1(labelRows),
    },
    matrix,
    aLabels: labels,
    bLabels: labels,
  };
}
