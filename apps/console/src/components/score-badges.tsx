import type { TraceListScore } from "../lib/api";

/** Collapse a trace's raw scores into one entry per name (numeric → avg, else latest category). */
export function aggregateScores(list: TraceListScore[]) {
  const byName = new Map<string, { vals: number[]; str: string }>();
  for (const s of list) {
    const e = byName.get(s.name) ?? { vals: [], str: "" };
    if (s.value != null) e.vals.push(s.value);
    else if (s.string_value) e.str = s.string_value;
    byName.set(s.name, e);
  }
  return [...byName.entries()].map(([name, e]) => {
    const count = e.vals.length || (e.str ? 1 : 0);
    const display = e.vals.length
      ? Number((e.vals.reduce((a, b) => a + b, 0) / e.vals.length).toFixed(2)).toString()
      : e.str || "—";
    return { name, display, count };
  });
}

/**
 * Aggregated score pills for a trace row. If `onPick` is provided each pill is a button that
 * filters by that score name (traces list); otherwise they're read-only (session/user detail).
 */
export function ScoreBadges({ scores, onPick }: { scores: TraceListScore[]; onPick?: (name: string) => void }) {
  const agg = aggregateScores(scores);
  if (agg.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {agg.map((s) => {
        const title = `${s.name}${s.count > 1 ? ` · avg of ${s.count}` : ""}`;
        const inner = (
          <>
            <span className="text-muted-foreground">{s.name}</span>
            <span className="font-medium tabular-nums">{s.display}</span>
          </>
        );
        return onPick ? (
          <button
            key={s.name}
            type="button"
            title={`Filter by score “${title}”`}
            onClick={(e) => {
              e.stopPropagation();
              onPick(s.name);
            }}
            className="inline-flex items-center gap-1 border bg-muted px-1.5 py-0.5 text-xs hover:bg-muted/70"
          >
            {inner}
          </button>
        ) : (
          <span
            key={s.name}
            title={title}
            className="inline-flex items-center gap-1 border bg-muted px-1.5 py-0.5 text-xs"
          >
            {inner}
          </span>
        );
      })}
    </div>
  );
}
