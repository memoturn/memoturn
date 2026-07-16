/**
 * Dependency-free text diff for the console (prompt-version compare, trace compare).
 *
 * Three layers, all pure:
 *  - `diffLines`  — line-level longest-common-subsequence (the original prompt-compare diff).
 *  - `diffWords`  — word/character-level LCS within a single changed line, for intra-line
 *                   highlighting (the piece a plain line-diff lacks).
 *  - `diffLinesAligned` — pairs a hunk's deletions with its insertions into side-by-side
 *                   "change" rows (with word highlights) for a two-pane view; standalone
 *                   deletions/insertions become one-sided rows with a gap on the other side.
 *
 * No diff library is used — an LCS DP is ~20 lines and exact for our payload sizes.
 */

export type LineOp = "same" | "add" | "del";
export interface DiffRow {
  type: LineOp;
  text: string;
}

/** Line-level diff via longest-common-subsequence. */
export function diffLines(a: string, b: string): DiffRow[] {
  const aL = a.split("\n");
  const bL = b.split("\n");
  return lcsDiff(aL, bL, (x, y) => x === y).map((op) => ({
    type: op.op,
    text: op.op === "add" ? bL[op.bi]! : aL[op.ai]!,
  }));
}

export interface DiffToken {
  text: string;
  changed: boolean;
}

/** Split a line into diffable tokens: whitespace runs, word runs, and single punctuation chars. */
function tokenize(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
}

/** Word/char-level diff of two single lines → per-side tokens, each flagged changed or not. */
export function diffWords(a: string, b: string): { left: DiffToken[]; right: DiffToken[] } {
  const aT = tokenize(a);
  const bT = tokenize(b);
  const left: DiffToken[] = [];
  const right: DiffToken[] = [];
  for (const op of lcsDiff(aT, bT, (x, y) => x === y)) {
    if (op.op === "same") {
      left.push({ text: aT[op.ai]!, changed: false });
      right.push({ text: bT[op.bi]!, changed: false });
    } else if (op.op === "del") {
      left.push({ text: aT[op.ai]!, changed: true });
    } else {
      right.push({ text: bT[op.bi]!, changed: true });
    }
  }
  return { left, right };
}

export type RowKind = "same" | "add" | "del" | "change";
export interface DiffCell {
  lineNo: number;
  tokens: DiffToken[];
}
export interface AlignedRow {
  kind: RowKind;
  left: DiffCell | null;
  right: DiffCell | null;
}

/** Side-by-side aligned diff: pairs each hunk's deletions with its insertions as "change" rows. */
export function diffLinesAligned(a: string, b: string): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let ln = 0;
  let rn = 0;
  let dels: string[] = [];
  let adds: string[] = [];
  const plain = (t: string): DiffToken[] => [{ text: t, changed: false }];

  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let x = 0; x < paired; x++) {
      const w = diffWords(dels[x]!, adds[x]!);
      rows.push({ kind: "change", left: { lineNo: ++ln, tokens: w.left }, right: { lineNo: ++rn, tokens: w.right } });
    }
    for (let x = paired; x < dels.length; x++) {
      rows.push({ kind: "del", left: { lineNo: ++ln, tokens: plain(dels[x]!) }, right: null });
    }
    for (let x = paired; x < adds.length; x++) {
      rows.push({ kind: "add", left: null, right: { lineNo: ++rn, tokens: plain(adds[x]!) } });
    }
    dels = [];
    adds = [];
  };

  for (const r of diffLines(a, b)) {
    if (r.type === "same") {
      flush();
      rows.push({
        kind: "same",
        left: { lineNo: ++ln, tokens: plain(r.text) },
        right: { lineNo: ++rn, tokens: plain(r.text) },
      });
    } else if (r.type === "del") {
      dels.push(r.text);
    } else {
      adds.push(r.text);
    }
  }
  flush();
  return rows;
}

/** Added/removed line counts for a summary badge (a "change" row counts as both). */
export function diffStats(rows: AlignedRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
    else if (r.kind === "change") {
      added++;
      removed++;
    }
  }
  return { added, removed };
}

/** Pretty-print a JSON string for stable line-diffing; returns the raw text if it isn't JSON. */
export function normalizeJson(raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ── LCS core ─────────────────────────────────────────────────────────────────────
type LcsOp =
  | { op: "same"; ai: number; bi: number }
  | { op: "del"; ai: number; bi: -1 }
  | { op: "add"; ai: -1; bi: number };

/** Longest-common-subsequence alignment of two sequences into same/del/add ops. */
function lcsDiff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): LcsOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = eq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) {
      ops.push({ op: "same", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: "del", ai: i, bi: -1 });
      i++;
    } else {
      ops.push({ op: "add", ai: -1, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", ai: i++, bi: -1 });
  while (j < m) ops.push({ op: "add", ai: -1, bi: j++ });
  return ops;
}
