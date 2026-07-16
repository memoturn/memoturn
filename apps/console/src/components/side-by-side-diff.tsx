import { useMemo } from "react";
import { type AlignedRow, type DiffCell, diffLinesAligned, diffStats, type RowKind } from "../lib/diff";
import { cn } from "../lib/utils";

/**
 * Two-pane side-by-side text diff — a dependency-free reimplementation of the mismerge look:
 * line-number gutters, color-coded rows (added / removed / changed), and word-level
 * highlighting inside changed lines. Long lines wrap (no horizontal scroll) so the two panes
 * stay row-aligned. Pure presentation over `diffLinesAligned`.
 */

// Per-side row background by kind — the pane-level tint.
const ROW_BG: Record<RowKind, { left: string; right: string }> = {
  same: { left: "", right: "" },
  del: { left: "bg-red-500/10", right: "bg-muted/30" },
  add: { left: "bg-muted/30", right: "bg-emerald-500/10" },
  change: { left: "bg-red-500/10", right: "bg-emerald-500/10" },
};

// Brighter highlight for the specific changed tokens within a changed line.
const TOKEN_HL: Record<"del" | "add", string> = {
  del: "bg-red-500/30 text-red-700 dark:text-red-200 rounded-[2px]",
  add: "bg-emerald-500/30 text-emerald-700 dark:text-emerald-200 rounded-[2px]",
};

function Half({ cell, side, kind }: { cell: DiffCell | null; side: "left" | "right"; kind: RowKind }) {
  const hl = side === "left" ? TOKEN_HL.del : TOKEN_HL.add;
  return (
    <div className={cn("flex min-w-0", cell ? ROW_BG[kind][side] : "bg-muted/20")}>
      <span className="w-10 shrink-0 select-none border-r px-1.5 py-0.5 text-right text-muted-foreground/60 tabular-nums">
        {cell?.lineNo ?? ""}
      </span>
      <code className="min-w-0 flex-1 px-2 py-0.5 whitespace-pre-wrap break-all">
        {cell
          ? cell.tokens.map((t, i) =>
              t.changed ? (
                <span key={i} className={hl}>
                  {t.text}
                </span>
              ) : (
                <span key={i}>{t.text}</span>
              ),
            )
          : " "}
      </code>
    </div>
  );
}

export function SideBySideDiff({
  left,
  right,
  leftLabel = "A",
  rightLabel = "B",
  className,
}: {
  left: string;
  right: string;
  leftLabel?: string;
  rightLabel?: string;
  className?: string;
}) {
  const rows = useMemo(() => diffLinesAligned(left, right), [left, right]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const identical = stats.added === 0 && stats.removed === 0;

  return (
    <div className={cn("overflow-hidden rounded-md border font-mono text-xs", className)}>
      <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1 text-[0.6875rem] font-medium">
        <div className="flex gap-4">
          <span className="text-muted-foreground">{leftLabel}</span>
          <span className="text-muted-foreground">{rightLabel}</span>
        </div>
        {identical ? (
          <span className="text-muted-foreground">Identical</span>
        ) : (
          <div className="flex gap-2 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
            <span className="text-red-600 dark:text-red-400">−{stats.removed}</span>
          </div>
        )}
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <div className="grid grid-cols-2 leading-relaxed">
          {rows.map((row: AlignedRow, i) => (
            <div key={i} className="contents">
              <Half cell={row.left} side="left" kind={row.kind} />
              <Half cell={row.right} side="right" kind={row.kind} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
