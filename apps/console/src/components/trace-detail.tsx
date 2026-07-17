import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Flag,
  FlaskConical,
  Plus,
  RotateCcw,
  Tag,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TraceGraph } from "../features/trace-graph/TraceGraph";
import {
  api,
  fetchOffloadedPayload,
  type ObservationDetail,
  type ScoreConfig,
  type ScoreRow,
  type TraceDetail,
} from "../lib/api";
import { useIsReadOnly } from "../lib/role";
import { cn } from "../lib/utils";
import { CopyButton } from "./copy-button";
import { EmptyState } from "./empty-state";
import { HelpTip } from "./help-tip";
import { KindBadge, type KindBadgeTone, toneForKind } from "./kind-badge";
import { ProviderIcon } from "./provider-icon";
import { SimilarTraces } from "./similar-traces";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb";
import { Button } from "./ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";

function pretty(value: string): string {
  if (!value) return "—";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ms(t: string | null): number | null {
  if (!t) return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}

/** Smooth scroll, but instant for users who prefer reduced motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Tone for a trace score source (EVAL / ANNOTATION / other). */
function toneForSource(source: string): KindBadgeTone {
  if (source === "EVAL") return "blue";
  if (source === "ANNOTATION") return "green";
  return "amber";
}

/** Tone for an observation level — errors read red, warnings amber. */
function toneForLevel(level: string): KindBadgeTone {
  if (level === "ERROR") return "red";
  if (level === "WARNING") return "amber";
  return "neutral";
}

/** Score comments are meant for human notes; some evaluators stuff a JSON blob here — hide those inline. */
function looksJson(comment: string): boolean {
  return /^\s*[[{]/.test(comment);
}

const PRE_CLASS = "overflow-auto border bg-muted/50 p-3 text-xs max-h-80";

/** Parse a large-payload offload marker ({_truncated, ref, preview, bytes}), else null. */
function truncatedMarker(raw: string): { ref: string; preview: string; bytes: number } | null {
  if (!raw?.includes("_truncated")) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && v._truncated === true && typeof v.ref === "string") {
      return { ref: v.ref, preview: String(v.preview ?? ""), bytes: Number(v.bytes ?? 0) };
    }
  } catch {
    /* not a marker */
  }
  return null;
}

function tryParse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A chat-message array: every element is an object carrying a `role`. */
function isMessageArray(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x != null && typeof x === "object" && !Array.isArray(x) && "role" in x)
  );
}

function renderScalar(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const MAX_ROWS = 300;

/** Flatten a value into dotted `path → scalar` rows for the Path/Value table (row/depth capped). */
function flatten(value: unknown, prefix = "", depth = 0, rows: { path: string; value: string }[] = []) {
  if (rows.length >= MAX_ROWS) return rows;
  const isObj = value !== null && typeof value === "object";
  if (!isObj || depth >= 6) {
    rows.push({ path: prefix || "(value)", value: renderScalar(value) });
    return rows;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    rows.push({ path: prefix || "(root)", value: Array.isArray(value) ? "[]" : "{}" });
    return rows;
  }
  for (const [k, v] of entries) {
    if (rows.length >= MAX_ROWS) {
      rows.push({ path: "…", value: `(${entries.length} keys — truncated)` });
      break;
    }
    flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, rows);
  }
  return rows;
}

function PathValueTable({ value }: { value: unknown }) {
  const rows = useMemo(() => flatten(value), [value]);
  return (
    <div className="max-h-96 overflow-auto border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Path</th>
            <th className="px-2 py-1 text-left font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} className="border-t align-top">
              <td className="px-2 py-1 font-mono whitespace-nowrap text-muted-foreground">{r.path}</td>
              <td className="px-2 py-1 font-mono break-all whitespace-pre-wrap">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One chat message: role/name header, then content as text (simple) or a Path/Value table. */
function MessageCard({ msg }: { msg: Record<string, unknown> }) {
  const { role, name, content, ...rest } = msg;
  const extras = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null && v !== ""));
  const simpleText = typeof content === "string" && Object.keys(extras).length === 0;
  return (
    <div className="space-y-1.5 border bg-muted/30 p-2">
      <div className="text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
        {String(role ?? "message")}
        {name ? ` · ${String(name)}` : ""}
      </div>
      {simpleText ? (
        content ? (
          <div className="text-sm whitespace-pre-wrap">{content as string}</div>
        ) : (
          <div className="text-sm text-muted-foreground italic">(empty)</div>
        )
      ) : (
        <PathValueTable value={{ ...(content !== undefined ? { content } : {}), ...extras }} />
      )}
    </div>
  );
}

function FormattedValue({ value }: { value: unknown }) {
  if (isMessageArray(value)) {
    return (
      <div className="max-h-96 space-y-2 overflow-auto">
        {value.map((m, i) => (
          <MessageCard key={i} msg={m} />
        ))}
      </div>
    );
  }
  return <PathValueTable value={value} />;
}

/** Formatted ⇄ JSON toggle (only shown for structured payloads). */
function ViewToggle({ mode, onChange }: { mode: "formatted" | "json"; onChange: (m: "formatted" | "json") => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
      {(["formatted", "json"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded px-2 py-0.5 text-xs capitalize transition-colors",
            mode === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/** Render a resolved payload string: structured values get a Formatted/JSON toggle; else raw pre. */
function PayloadBody({ value }: { value: string }) {
  const parsed = useMemo(() => tryParse(value), [value]);
  const structured = parsed !== null && typeof parsed === "object";
  const [mode, setMode] = useState<"formatted" | "json">("formatted");

  if (!structured) return <pre className={PRE_CLASS}>{pretty(value)}</pre>;

  return (
    <div className="space-y-1.5">
      <div className="flex justify-end">
        <ViewToggle mode={mode} onChange={setMode} />
      </div>
      {mode === "json" ? <pre className={PRE_CLASS}>{pretty(value)}</pre> : <FormattedValue value={parsed} />}
    </div>
  );
}

/**
 * Render an input/output payload. If it was offloaded to blob at ingest (too large for
 * the telemetry store), show the stored preview + a button to fetch the full value on demand.
 * Exported so other payload surfaces (e.g. the review queue) share the Formatted/JSON viewer.
 */
export function PayloadView({ raw }: { raw: string }) {
  const marker = truncatedMarker(raw);
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!marker) return <PayloadBody value={raw} />;
  if (full !== null) return <PayloadBody value={full} />;

  const load = async () => {
    setLoading(true);
    try {
      setFull(await fetchOffloadedPayload(marker.ref));
    } catch (e) {
      toast.error(`Failed to load payload: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <pre className={PRE_CLASS}>{pretty(marker.preview)}…</pre>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Truncated · {(marker.bytes / 1024).toFixed(0)} KB offloaded to blob</span>
        <Button variant="outline" size="sm" disabled={loading} onClick={load}>
          {loading ? "Loading…" : "Load full payload"}
        </Button>
      </div>
    </div>
  );
}

// ── Multimodal media: render attachments referenced in input/output ───────────────
const MEDIA_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const MEDIA_RE = /memoturn-media:\/\/[A-Za-z0-9/_.-]+/g;
const DATA_IMG_RE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const IMG_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

function MediaPreview({ raw }: { raw: string }) {
  if (!raw) return null;
  const markers = raw.match(MEDIA_RE) ?? [];
  const dataImgs = raw.match(DATA_IMG_RE) ?? [];
  if (markers.length === 0 && dataImgs.length === 0) return null;
  return (
    <div className="my-2 flex flex-wrap gap-2">
      {markers.map((m) => {
        const key = m.slice("memoturn-media://".length);
        const url = `${MEDIA_BASE}/v1/media/${key}`;
        return IMG_EXT.test(key) ? (
          <img key={m} className="h-24 border object-cover" src={url} alt="attachment" />
        ) : (
          <Button key={m} asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              <Download className="size-3.5" /> download
            </a>
          </Button>
        );
      })}
      {dataImgs.map((d) => (
        <img key={d.slice(0, 48)} className="h-24 border object-cover" src={d} alt="inline attachment" />
      ))}
    </div>
  );
}

/** Per-indent-column tree connector: continuing line, blank gap, branch (├), or last-child elbow (└). */
type GuideKind = "line" | "blank" | "tee" | "elbow";

interface Laid extends ObservationDetail {
  depth: number;
  offsetPct: number;
  widthPct: number;
  startOffsetMs: number;
  guides: GuideKind[];
  hasChildren: boolean;
  /** Descendants hidden because this node is collapsed (0 when expanded / leaf). */
  hiddenCount: number;
  /** True when an ERROR observation lives at or below this node (highlight the failing branch). */
  onFailedPath: boolean;
  /** Cost/tokens summed over this node and all its descendants (for the collapsed-subtree rollup). */
  subtreeCost: number;
  subtreeTokens: number;
  /** This node's duration as a fraction of the trace's slowest node (0–1) — drives latency heat. */
  heatFrac: number;
}

/**
 * Ids of every observation on a path to a failure: each ERROR node plus all its ancestors.
 * Lets the waterfall highlight the failing branch — even when the error is collapsed away.
 */
function failedPathIds(observations: ObservationDetail[]): Set<string> {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const out = new Set<string>();
  for (const o of observations) {
    if (o.level !== "ERROR") continue;
    out.add(o.id);
    let p: string | undefined = o.parent_observation_id;
    while (p && byId.has(p) && !out.has(p)) {
      out.add(p);
      p = byId.get(p)?.parent_observation_id;
    }
  }
  return out;
}

/**
 * Compute waterfall layout: rows in tree pre-order (parent → its children), each with the
 * connector guides for its indent columns, and bar offset/width from times. Cyclic/orphaned
 * observations (parent not in the set) render as roots so nothing is dropped.
 */
function layout(observations: ObservationDetail[], collapsed: Set<string>, failed: Set<string>): Laid[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const startMs = (o: ObservationDetail) => ms(o.start_time) ?? 0;

  const starts = observations.map(startMs);
  // end_time can be coarser than latency_ms (second precision), so trust whichever runs longer.
  const ends = observations.map((o, i) => Math.max(ms(o.end_time) ?? 0, starts[i]! + Number(o.latency_ms)));
  const traceStart = Math.min(...starts);
  const total = Math.max(1, Math.max(...ends) - traceStart);
  const startOffOf = new Map(observations.map((o, i) => [o.id, starts[i]! - traceStart]));

  // Build the child lists (only for parents present in the set); everything else is a root.
  const children = new Map<string, ObservationDetail[]>();
  const roots: ObservationDetail[] = [];
  for (const o of observations) {
    const parentId = o.parent_observation_id;
    if (parentId && byId.has(parentId) && parentId !== o.id) {
      const arr = children.get(parentId) ?? [];
      arr.push(o);
      children.set(parentId, arr);
    } else {
      roots.push(o);
    }
  }
  const byStart = (a: ObservationDetail, b: ObservationDetail) => startMs(a) - startMs(b);
  roots.sort(byStart);
  for (const arr of children.values()) arr.sort(byStart);

  // Total descendants under a node (for the "+N hidden" badge on a collapsed row).
  const descCache = new Map<string, number>();
  const descCount = (id: string): number => {
    const cached = descCache.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id) ?? [];
    const n = kids.reduce((acc, k) => acc + 1 + descCount(k.id), 0);
    descCache.set(id, n);
    return n;
  };

  // Subtree cost/token rollups (node + all descendants) — shown on collapsed parents so a folded
  // subgraph still reports its aggregate spend. Memoized post-order over the same child map.
  const rollupCache = new Map<string, { cost: number; tokens: number }>();
  const rollup = (id: string): { cost: number; tokens: number } => {
    const cached = rollupCache.get(id);
    if (cached) return cached;
    const self = byId.get(id);
    let cost = Number(self?.total_cost ?? 0);
    let tokens = Number(self?.total_tokens ?? 0);
    for (const k of children.get(id) ?? []) {
      const r = rollup(k.id);
      cost += r.cost;
      tokens += r.tokens;
    }
    const r = { cost, tokens };
    rollupCache.set(id, r);
    return r;
  };

  // Heat is relative to the slowest single node so one long generation doesn't wash out the rest.
  const maxLatency = Math.max(1, ...observations.map((o) => Number(o.latency_ms)));

  const out: Laid[] = [];
  const visited = new Set<string>();
  const place = (node: ObservationDetail, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
    if (visited.has(node.id)) return; // cycle guard
    visited.add(node.id);
    const startOff = startOffOf.get(node.id) ?? 0;
    const offsetPct = Math.min((startOff / total) * 100, 98.5);
    const widthPct = Math.max(1.5, Math.min((Number(node.latency_ms) / total) * 100, 100 - offsetPct));
    const guides: GuideKind[] = [];
    for (let c = 0; c < depth; c++) {
      if (c < depth - 1) guides.push(ancestorContinues[c] ? "line" : "blank");
      else guides.push(isLast ? "elbow" : "tee");
    }
    const kids = children.get(node.id) ?? [];
    const isCollapsed = kids.length > 0 && collapsed.has(node.id);
    out.push({
      ...node,
      depth,
      offsetPct,
      widthPct,
      startOffsetMs: startOff,
      guides,
      hasChildren: kids.length > 0,
      hiddenCount: isCollapsed ? descCount(node.id) : 0,
      onFailedPath: failed.has(node.id),
      subtreeCost: rollup(node.id).cost,
      subtreeTokens: rollup(node.id).tokens,
      heatFrac: Number(node.latency_ms) / maxLatency,
    });
    if (isCollapsed) {
      // Mark the hidden subtree visited so the orphan safety-net below doesn't re-add
      // collapsed descendants as roots.
      const markHidden = (nid: string) => {
        for (const k of children.get(nid) ?? []) {
          if (!visited.has(k.id)) {
            visited.add(k.id);
            markHidden(k.id);
          }
        }
      };
      markHidden(node.id);
      return;
    }
    kids.forEach((kid, i) => {
      place(kid, depth + 1, [...ancestorContinues, !isLast], i === kids.length - 1);
    });
  };
  roots.forEach((r, i) => {
    place(r, 0, [], i === roots.length - 1);
  });
  // Safety net: any node not reached (part of a cycle) still gets a row, as a root.
  for (const o of observations) if (!visited.has(o.id)) place(o, 0, [], true);
  return out;
}

/** Every observation that has at least one child — the set "Collapse all" toggles. */
function collapsibleIds(observations: ObservationDetail[]): Set<string> {
  const byId = new Set(observations.map((o) => o.id));
  const parents = new Set<string>();
  for (const o of observations) {
    const p = o.parent_observation_id;
    if (p && byId.has(p) && p !== o.id) parents.add(p);
  }
  return parents;
}

/** Bar hues match the KindBadge tones: generation=blue, span=emerald, tool=amber, agent=violet, event=slate. */
function barColor(type: string): string {
  if (type === "GENERATION") return "bg-blue-500";
  if (type === "SPAN") return "bg-emerald-500";
  if (type === "TOOL") return "bg-amber-500";
  if (type === "AGENT") return "bg-violet-500";
  return "bg-slate-400";
}

/** Human duration: sub-second in ms, otherwise seconds (2 sig figs). */
function fmtDuration(msVal: number): string {
  return msVal >= 1000 ? `${(msVal / 1000).toFixed(2)}s` : `${msVal} ms`;
}

/** Latency heat: the slowest nodes tint red, medium amber, everything else stays muted. */
function heatTone(frac: number): string {
  if (frac >= 0.66) return "text-destructive";
  if (frac >= 0.33) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/** Compact cost for subtree rollups: cents get 2 dp, sub-cent gets 4 dp, zero elides. */
function fmtCostCompact(v: number): string {
  if (v <= 0) return "$0";
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** Compact token count (21931 → 21.9k). */
function fmtTokensCompact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Parse an observation's metadata JSON into a few scalar key/value chips (matching the tree's
 * inline-annotation style). Skips nested/array/long values so the chip row stays scannable; note
 * these are per-observation metadata, not scores (memoturn scores attach to the trace, not spans).
 */
function metaChips(metadata: string, limit = 3): [string, string][] {
  if (!metadata || metadata === "{}") return [];
  try {
    const obj = JSON.parse(metadata) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v == null) continue;
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") continue;
      const s = String(v);
      if (s.length > 32) continue;
      out.push([k, s]);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

const WATERFALL_COLS = "grid-cols-[minmax(220px,300px)_1fr_5.5rem]";

/** One indent-column connector for the trace tree: continuing line, gap, branch (├), or last elbow (└). */
function TreeGuide({ kind, x }: { kind: GuideKind; x: number }) {
  if (kind === "blank") return null;
  if (kind === "line") {
    return <span aria-hidden className="absolute inset-y-0 w-px bg-border/70" style={{ left: x }} />;
  }
  // tee (├) has siblings below → full-height vertical; elbow (└) is the last child → top-half only.
  return (
    <>
      <span
        aria-hidden
        className="absolute top-0 w-px bg-border/70"
        style={{ left: x, height: kind === "tee" ? "100%" : "50%" }}
      />
      <span aria-hidden className="absolute h-px w-2.5 bg-border/70" style={{ left: x, top: "50%" }} />
    </>
  );
}

function WaterfallRow({
  obs,
  selected,
  onSelect,
  onToggle,
}: {
  obs: Laid;
  selected?: boolean;
  onSelect?: () => void;
  onToggle?: () => void;
}) {
  const collapsed = obs.hiddenCount > 0;
  const chips = metaChips(obs.metadata);
  const showRollup = collapsed && (obs.subtreeCost > 0 || obs.subtreeTokens > 0);
  // Errors/warnings tint the whole row so failures pop while scanning the waterfall.
  const tint =
    obs.level === "ERROR"
      ? "bg-destructive/5 hover:bg-destructive/10"
      : obs.level === "WARNING"
        ? "bg-amber-500/5 hover:bg-amber-500/10"
        : "hover:bg-muted/40";
  // Ancestor of a failure → accent the branch so you can trace the failing path (the ERROR row
  // itself already carries the red tint).
  const failAccent = obs.onFailedPath && obs.level !== "ERROR" ? "border-l-2 border-l-destructive/50" : "";
  // Selection uses a ring (not a bg) so it reads on top of the error/warning tints too.
  const selectedRing = selected ? "bg-muted/50 ring-1 ring-inset ring-primary/50" : "";
  const bar = obs.level === "ERROR" ? "bg-destructive" : barColor(obs.type);
  const label = `${obs.name || obs.id.slice(0, 8)}${obs.model ? ` · ${obs.model}` : ""}`;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: interactive only when onSelect is set, where role/tabIndex/onKeyDown are all provided
    <div
      data-obs-row={obs.id}
      className={`group grid ${WATERFALL_COLS} items-center border-b transition-colors last:border-b-0 ${tint} ${failAccent} ${selectedRing} ${onSelect ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none" : ""}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-current={selected || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div
        className="relative overflow-hidden py-2 pr-3"
        style={{ paddingLeft: `${12 + obs.depth * 16}px` }}
        title={obs.status_message ? `${label} — ${obs.status_message}` : label}
      >
        {/* Tree connectors: continuing │ per ancestor, then a ├/└ elbow into this node. */}
        {obs.guides.map((g, c) => (
          <TreeGuide key={`${c}-${g}`} kind={g} x={18 + c * 16} />
        ))}
        <div className="flex min-w-0 items-center gap-1.5">
          {obs.hasChildren ? (
            <button
              type="button"
              aria-label={collapsed ? "Expand subgraph" : "Collapse subgraph"}
              className="-ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onToggle?.();
              }}
            >
              {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" aria-hidden />
          )}
          <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>
          {/* Name gets the full column width; the model sits on a muted second line so a long
              model string ("claude-sonnet-4-6") never clips a short name ("step-2"). */}
          <div className="flex min-w-0 flex-col justify-center">
            <span className="truncate font-medium leading-tight">{obs.name || obs.id.slice(0, 8)}</span>
            {obs.model && (
              <span
                className="flex min-w-0 items-center gap-1 text-[0.6875rem] leading-tight text-muted-foreground"
                title={obs.model}
              >
                <ProviderIcon provider={obs.provider} model={obs.model} size={12} />
                <span className="truncate">{obs.model}</span>
              </span>
            )}
          </div>
          {collapsed && (
            <span className="shrink-0 rounded bg-muted px-1 text-[0.6875rem] tabular-nums text-muted-foreground">
              +{obs.hiddenCount}
            </span>
          )}
          {obs.level !== "DEFAULT" && <KindBadge tone={toneForLevel(obs.level)}>{obs.level.toLowerCase()}</KindBadge>}
        </div>
        {/* Inline annotations: a Σ cost/token rollup for collapsed subtrees, plus a few scalar
            metadata chips so per-span context is visible without opening the payload pane. */}
        {(showRollup || chips.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1 pl-5">
            {showRollup && (
              <span className="rounded bg-muted px-1 text-[0.625rem] tabular-nums text-muted-foreground">
                Σ {fmtCostCompact(obs.subtreeCost)} · {fmtTokensCompact(obs.subtreeTokens)} tok
              </span>
            )}
            {chips.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex max-w-[11rem] items-center gap-1 rounded border border-border/60 bg-muted/40 px-1 text-[0.625rem] text-muted-foreground"
                title={`${k}: ${v}`}
              >
                <span className="shrink-0 font-medium text-foreground/70">{k}</span>
                <span className="truncate tabular-nums">{v}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative mr-4 h-7" title={`+${Math.round(obs.startOffsetMs)} ms → ${obs.latency_ms} ms`}>
        {/* Time gridlines at 25/50/75% — align with the bar coordinate space. */}
        <span aria-hidden className="absolute inset-y-1 left-1/4 w-px bg-border/40" />
        <span aria-hidden className="absolute inset-y-1 left-1/2 w-px bg-border/40" />
        <span aria-hidden className="absolute inset-y-1 left-3/4 w-px bg-border/40" />
        <div
          className={`absolute top-1/2 h-2 min-w-[3px] -translate-y-1/2 rounded-full ring-1 ring-black/5 ring-inset transition-[filter] group-hover:brightness-110 ${bar}`}
          style={{ left: `${obs.offsetPct}%`, width: `${obs.widthPct}%` }}
        />
      </div>
      {/* Duration tinted by latency heat (relative to the trace's slowest node) so slow spans
          jump out while scanning. ERROR rows keep their red regardless. */}
      <span className={`py-2 pr-3 text-right text-xs tabular-nums ${heatTone(obs.heatFrac)}`}>
        {fmtDuration(obs.latency_ms)}
      </span>
    </div>
  );
}

function visibleObservations(observations: ObservationDetail[]): ObservationDetail[] {
  return observations.filter(
    (obs) => obs.input || obs.output || obs.level !== "DEFAULT" || obs.retrieval_documents.length > 0,
  );
}

/** Playground handoff: the trace detail writes this, the playground route reads + clears it on mount. */
const PLAYGROUND_SEED_KEY = "memoturn.playground.seed";

/**
 * Seed the playground from a generation: pull the system + last user message out of the observation's
 * input (chat-message array, else the raw input as the user message), plus its provider/model.
 */
function writePlaygroundSeed(obs: ObservationDetail) {
  const parsed = tryParse(obs.input);
  let system = "";
  let userMsg = "";
  if (isMessageArray(parsed)) {
    for (const m of parsed) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (String(m.role) === "system") system = content;
      else userMsg = content;
    }
  } else {
    userMsg = typeof parsed === "string" ? parsed : obs.input;
  }
  try {
    localStorage.setItem(
      PLAYGROUND_SEED_KEY,
      JSON.stringify({ provider: obs.provider, model: obs.model, system, userMsg }),
    );
  } catch {
    /* storage unavailable — the playground just opens with its defaults */
  }
}

/** Add this generation's input (+ output as expected) to a dataset — a dropdown of the project's datasets. */
function AddToDatasetButton({ obs }: { obs: ObservationDetail }) {
  const readOnly = useIsReadOnly();
  const { data: datasets } = useQuery({ queryKey: ["datasets"], queryFn: () => api.listDatasets() });
  const add = useMutation({
    mutationFn: (name: string) =>
      api.addDatasetItems(name, [
        {
          input: tryParse(obs.input) ?? obs.input,
          expectedOutput: obs.output ? (tryParse(obs.output) ?? obs.output) : undefined,
        },
      ]),
    onSuccess: (_res, name) => toast.success(`Added to dataset “${name}”`),
    onError: (e) => toast.error(`Failed to add: ${String(e)}`),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={readOnly}>
          <Database className="size-3.5" />
          Add to dataset
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Add as a dataset item</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!datasets || datasets.length === 0 ? (
          <DropdownMenuItem disabled>No datasets — create one under Datasets</DropdownMenuItem>
        ) : (
          datasets.map((d) => (
            <DropdownMenuItem key={d.name} onSelect={() => add.mutate(d.name)}>
              {d.name}
              <span className="ml-auto text-xs text-muted-foreground">{Number(d.items)} items</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The input/output/retrieval/status body for one observation — the master-detail pane's content. */
function ObservationPayloadContent({ obs }: { obs: ObservationDetail }) {
  return (
    <div className="space-y-3">
      {obs.type === "GENERATION" && obs.input && (
        <div className="flex flex-wrap justify-end gap-2">
          <AddToDatasetButton obs={obs} />
          <Button asChild variant="outline" size="sm">
            <Link to="/playground" onClick={() => writePlaygroundSeed(obs)}>
              <FlaskConical className="size-3.5" />
              Open in Playground
            </Link>
          </Button>
        </div>
      )}
      <MediaPreview raw={obs.input} />
      <MediaPreview raw={obs.output} />
      {obs.input && (
        <div className="space-y-1">
          <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Input</div>
          <PayloadView raw={obs.input} />
        </div>
      )}
      {obs.output && (
        <div className="space-y-1">
          <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Output</div>
          <PayloadView raw={obs.output} />
        </div>
      )}
      {obs.retrieval_documents.length > 0 && <RetrievalDocs docs={obs.retrieval_documents} />}
      {obs.status_message && (
        <div className="space-y-1">
          <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Status</div>
          <pre className={PRE_CLASS}>{obs.status_message}</pre>
        </div>
      )}
    </div>
  );
}

/** The selected observation's payload with an identifying header — the detail half of the split. */
function ObservationDetailPanel({ obs }: { obs: ObservationDetail }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 border-b pb-3">
        <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>
        <span className="font-medium">{obs.name || obs.id.slice(0, 8)}</span>
        {obs.total_tokens > 0 && <span className="text-muted-foreground">· {obs.total_tokens} tok</span>}
        {Number(obs.total_cost) > 0 && (
          <span className="text-muted-foreground">· ${Number(obs.total_cost).toFixed(6)}</span>
        )}
        {obs.level !== "DEFAULT" && <KindBadge tone={toneForLevel(obs.level)}>{obs.level.toLowerCase()}</KindBadge>}
        {obs.prompt_id && (
          <Link
            to="/prompts/$name"
            params={{ name: obs.prompt_id }}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Tag className="size-3" />
            {obs.prompt_id}
            {obs.prompt_version ? ` v${obs.prompt_version}` : ""}
          </Link>
        )}
      </div>
      <ObservationPayloadContent obs={obs} />
    </div>
  );
}

/** Retrieved documents for a RAG/retriever span — ranked, with relevance score + source. */
function RetrievalDocs({ docs }: { docs: ObservationDetail["retrieval_documents"] }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        Retrieved documents ({docs.length})
      </div>
      <div className="space-y-1.5">
        {docs.map((d) => (
          <div key={d.rank} className="rounded-md border p-2">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <KindBadge tone="blue">#{d.rank}</KindBadge>
              {d.score != null && <span>score {d.score.toFixed(4)}</span>}
              {d.doc_id && <span className="truncate">· {d.doc_id}</span>}
            </div>
            <pre className={PRE_CLASS}>{d.content}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN";

type AnnotationPatch = { value?: number; stringValue?: string };

/** Numeric annotation: discrete integer scales render one button per value; continuous scales
 *  render quick-preset pills plus a precise number input (no slider). */
function NumericReviewField({
  cfg,
  active,
  disabled,
  onSubmit,
}: {
  cfg: ScoreConfig;
  active: ScoreRow | undefined;
  disabled: boolean;
  onSubmit: (patch: AnnotationPatch) => void;
}) {
  const min = cfg.min ?? 0;
  const max = cfg.max ?? 1;
  // Local text state for the continuous-scale number input (unused by the discrete branch, but
  // the hook must run unconditionally — rules of hooks).
  const [val, setVal] = useState<string>(active?.value != null ? String(active.value) : "");
  // Small integer scales (e.g. 1–5, 0–10) → one button per value, like the categorical scale.
  const discrete = Number.isInteger(min) && Number.isInteger(max) && max - min > 0 && max - min <= 10;

  if (discrete) {
    const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    return (
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Button
            key={v}
            variant={active?.value === v ? "default" : "outline"}
            size="sm"
            className="min-w-9 tabular-nums"
            disabled={disabled}
            onClick={() => onSubmit({ value: v })}
          >
            {v}
          </Button>
        ))}
      </div>
    );
  }

  // Continuous scale (e.g. 0–1) → quick presets + a precise number input. No dragging.
  const round = (n: number) => Number(n.toFixed(2));
  const presets = [
    ...new Set([min, round(min + (max - min) * 0.25), round((min + max) / 2), round(min + (max - min) * 0.75), max]),
  ];
  const submit = () => {
    const n = Number(val);
    if (val !== "" && Number.isFinite(n) && n >= min && n <= max) onSubmit({ value: n });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p}
            variant={active?.value === p ? "default" : "outline"}
            size="sm"
            className="min-w-11 tabular-nums"
            disabled={disabled}
            onClick={() => {
              setVal(String(p));
              onSubmit({ value: p });
            }}
          >
            {p}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={0.01}
          value={val}
          disabled={disabled}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onBlur={submit}
          placeholder="exact"
          aria-label={`${cfg.name} score`}
          className="h-8 w-24 tabular-nums"
        />
        <span className="text-xs text-muted-foreground">
          {min}–{max}
        </span>
      </div>
    </div>
  );
}

/** One score-config row: category buttons, pass/fail, or numeric buttons + input. */
function ReviewField({
  cfg,
  active,
  disabled,
  onSubmit,
}: {
  cfg: ScoreConfig;
  active: ScoreRow | undefined;
  disabled: boolean;
  onSubmit: (patch: AnnotationPatch) => void;
}) {
  return (
    <div className="space-y-1.5">
      {/* No standalone "current" value here: the highlighted button / pre-filled input already shows
          the active selection, and the Scores list below is the source of truth for recorded values. */}
      <span className="text-sm font-medium">{cfg.name}</span>
      {cfg.dataType === "CATEGORICAL" ? (
        <div className="flex flex-wrap gap-1.5">
          {cfg.categories.map((c) => (
            <Button
              key={c}
              variant={active?.string_value === c ? "default" : "outline"}
              size="sm"
              disabled={disabled}
              onClick={() => onSubmit({ stringValue: c })}
            >
              {c}
            </Button>
          ))}
        </div>
      ) : cfg.dataType === "BOOLEAN" ? (
        <div className="flex gap-1.5">
          <Button
            variant={active?.value === 1 ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => onSubmit({ value: 1 })}
          >
            Pass
          </Button>
          <Button
            variant={active?.value === 0 ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => onSubmit({ value: 0 })}
          >
            Fail
          </Button>
        </div>
      ) : (
        <NumericReviewField cfg={cfg} active={active} disabled={disabled} onSubmit={onSubmit} />
      )}
    </div>
  );
}

/**
 * Inline human-review panel: renders the project's score configs as always-visible inputs so a
 * reviewer can score a trace in one click (vs. the ad-hoc Annotate popover). Each submit writes an
 * ANNOTATION score through the ingest pipeline; the current value per config is highlighted.
 * Renders nothing when no score configs are defined.
 */
function InlineReview({ traceId, scores }: { traceId: string; scores: ScoreRow[] }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: configs } = useQuery({ queryKey: ["score-configs"], queryFn: () => api.listScoreConfigs() });

  const annotate = useMutation({
    mutationFn: (b: { name: string; dataType: ScoreDataType } & AnnotationPatch) => api.annotateTrace(traceId, b),
    onSuccess: () => {
      toast.success("Review saved");
      qc.invalidateQueries({ queryKey: ["trace", traceId] });
      // The score lands asynchronously via ingest — refetch again after a beat.
      setTimeout(() => qc.invalidateQueries({ queryKey: ["trace", traceId] }), 1500);
    },
    onError: (e) => toast.error(`Review failed: ${String(e)}`),
  });

  if (!configs || configs.length === 0) return null;

  // Latest ANNOTATION per config name (by timestamp) → the active/highlighted button. Sorting by
  // timestamp (not array order) makes "latest" well-defined and consistent with the Scores list.
  const current = new Map<string, ScoreRow>();
  for (const s of scores) {
    if (s.source !== "ANNOTATION") continue;
    const prev = current.get(s.name);
    if (!prev || s.timestamp > prev.timestamp) current.set(s.name, s);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Human review</CardTitle>
        <CardDescription>One-click scoring from your score configs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {configs.map((cfg) => (
          <ReviewField
            key={cfg.id}
            cfg={cfg}
            active={current.get(cfg.name)}
            disabled={readOnly}
            onSubmit={(patch) => annotate.mutate({ name: cfg.name, dataType: cfg.dataType, ...patch })}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/** Popover form to add a manual ANNOTATION score to a trace (human feedback). */
/** Inline tag editor — add/remove tags on a trace (writes through the merge-on-write store). */
function TagEditor({ traceId, tags }: { traceId: string; tags: string[] }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const [input, setInput] = useState("");
  const save = useMutation({
    mutationFn: (next: string[]) => api.setTraceTags(traceId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trace", traceId] });
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["trace-facets"] });
    },
    onError: (e) => toast.error(`Failed to update tags: ${String(e)}`),
  });
  const add = () => {
    const t = input.trim();
    setInput("");
    if (t && !tags.includes(t)) save.mutate([...tags, t]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.length === 0 && readOnly && <span className="text-xs text-muted-foreground">No tags</span>}
      {tags.map((t) => (
        <KindBadge key={t} tone="blue" className="gap-1">
          {t}
          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                save.mutate(tags.filter((x) => x !== t));
                // Removing a tag is trivially reversible, so offer undo rather than a confirm dialog.
                toast(`Removed tag “${t}”`, { action: { label: "Undo", onClick: () => save.mutate(tags) } });
              }}
              className="opacity-60 hover:opacity-100"
              aria-label={`Remove tag ${t}`}
            >
              ✕
            </button>
          )}
        </KindBadge>
      ))}
      {!readOnly && (
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="add tag…"
          disabled={save.isPending}
          className="h-6 w-24 border-b border-transparent bg-transparent text-xs outline-none placeholder:text-muted-foreground hover:border-input focus:border-ring"
        />
      )}
    </div>
  );
}

/** Add this trace to a review queue in one click — a dropdown of the project's queues. */
function FlagForReviewButton({ traceId }: { traceId: string }) {
  const readOnly = useIsReadOnly();
  const { data: queues } = useQuery({ queryKey: ["review-queues"], queryFn: () => api.listReviewQueues() });
  const add = useMutation({
    mutationFn: (queue: string) => api.addReviewItems(queue, [traceId]),
    onSuccess: (_res, queue) => toast.success(`Flagged for review in “${queue}”`),
    onError: (e) => toast.error(`Failed to flag: ${String(e)}`),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={readOnly}>
          <Flag className="size-3.5" />
          Flag for review
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Add to review queue</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!queues || queues.length === 0 ? (
          <DropdownMenuItem disabled>No queues — create one under Review</DropdownMenuItem>
        ) : (
          queues.map((q) => (
            <DropdownMenuItem key={q.name} onSelect={() => add.mutate(q.name)}>
              {q.name}
              <span className="ml-auto text-xs text-muted-foreground">{q.pending} pending</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AnnotateButton({ traceId }: { traceId: string }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState<ScoreDataType>("NUMERIC");
  const [value, setValue] = useState("");
  const [stringValue, setStringValue] = useState("");
  const [comment, setComment] = useState("");

  const annotate = useMutation({
    mutationFn: () =>
      api.annotateTrace(traceId, {
        name: name.trim(),
        dataType,
        value: dataType === "NUMERIC" ? Number(value) : dataType === "BOOLEAN" ? (value === "1" ? 1 : 0) : undefined,
        stringValue: dataType === "CATEGORICAL" ? stringValue.trim() : undefined,
        comment: comment.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Annotation saved — it will appear shortly");
      setOpen(false);
      setName("");
      setValue("");
      setStringValue("");
      setComment("");
      // The score lands asynchronously via the ingest pipeline — refetch now and again after a beat.
      qc.invalidateQueries({ queryKey: ["trace", traceId] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["trace", traceId] }), 1500);
    },
    onError: (e) => toast.error(`Annotation failed: ${String(e)}`),
  });

  const valid = name.trim() !== "" && (dataType === "CATEGORICAL" ? stringValue.trim() !== "" : value !== "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={readOnly}>
          <Plus />
          Annotate
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div className="text-sm font-medium">Add annotation</div>
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. quality" />
        </div>
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select value={dataType} onValueChange={(v) => setDataType(v as ScoreDataType)}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NUMERIC">Numeric</SelectItem>
              <SelectItem value="CATEGORICAL">Categorical</SelectItem>
              <SelectItem value="BOOLEAN">Boolean</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {dataType === "CATEGORICAL" ? (
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Input value={stringValue} onChange={(e) => setStringValue(e.target.value)} placeholder="e.g. good" />
          </div>
        ) : dataType === "BOOLEAN" ? (
          <div className="space-y-1.5">
            <Label>Value</Label>
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">True</SelectItem>
                <SelectItem value="0">False</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Value</Label>
            <Input
              type="number"
              step="any"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.0"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Comment</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" />
        </div>
        <Button size="sm" className="w-full" disabled={!valid || annotate.isPending} onClick={() => annotate.mutate()}>
          {annotate.isPending ? "Saving…" : "Save annotation"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Prompt/completion token split + prompt-cache breakdown, summed across a trace's
 * generations. Cache figures render only when present (non-caching traces stay clean).
 */
function MetricsGrid({ trace }: { trace: TraceDetail }) {
  const sum = (k: keyof ObservationDetail) => trace.observations.reduce((a, o) => a + Number(o[k] ?? 0), 0);
  const prompt = sum("prompt_tokens");
  const completion = sum("completion_tokens");
  const cacheRead = sum("cache_read_tokens");
  const cacheCreation = sum("cache_creation_tokens");
  const cost = Number(trace.total_cost);

  const items: { label: string; value: ReactNode; help?: string }[] = [
    { label: "Start", value: trace.timestamp.replace("T", " ").replace("Z", "") },
    {
      label: "Duration",
      value: `${trace.latency_ms} ms`,
      help: "Wall-clock span of the trace — from the first observation's start to the last one's end.",
    },
    {
      label: "Observations",
      value: trace.observation_count.toLocaleString(),
      help: "Spans, generations, and events recorded under this trace.",
    },
    { label: "Total tokens", value: Number(trace.total_tokens).toLocaleString() },
    { label: "Prompt tokens", value: prompt.toLocaleString(), help: "Input tokens sent to the model." },
    { label: "Completion tokens", value: completion.toLocaleString(), help: "Output tokens generated by the model." },
    ...(cacheRead > 0
      ? [
          {
            label: "Cache read",
            value: cacheRead.toLocaleString(),
            help: "Prompt tokens served from the provider's prompt cache — cheaper than fresh input.",
          },
        ]
      : []),
    ...(cacheCreation > 0
      ? [
          {
            label: "Cache write",
            value: cacheCreation.toLocaleString(),
            help: "Prompt tokens written to the provider's cache on this call for later reuse.",
          },
        ]
      : []),
    {
      label: "Est. cost",
      value: cost > 0 ? `$${cost.toFixed(6)}` : "—",
      help: "Estimated from token counts and the model price table — not a billed amount.",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Metrics</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((it) => (
            <div key={it.label} className="space-y-0.5">
              <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                {it.label}
                {it.help ? <HelpTip>{it.help}</HelpTip> : null}
              </dt>
              <dd className="text-sm font-semibold tabular-nums">{it.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Full trace detail — the query, stat strip, waterfall/graph, payloads and comments.
 * Shared by the full-page route (`/traces/$id`) and the peek drawer on the list, so
 * both stay in lockstep. `showBreadcrumb` is off in the drawer (its header carries context).
 */
export function TraceDetailBody({ traceId, showBreadcrumb = true }: { traceId: string; showBreadcrumb?: boolean }) {
  // Master-detail: the waterfall selects one observation; its payload shows in the detail pane.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Collapsed subgraphs in the waterfall (by observation id).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Observations view: the waterfall timeline (default) or the agent-flow graph.
  const [obsView, setObsView] = useState<"timeline" | "graph">("timeline");
  const payloadPanelRef = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const {
    data: trace,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => api.getTrace(traceId),
    // Keep the current trace on screen while the next one loads (smooth J/K stepping in the drawer).
    placeholderData: keepPreviousData,
  });

  // Latest "jump to next error" handler, so the always-on keydown effect below (registered before
  // the data-dependent early returns) can call it without re-subscribing every render.
  const nextErrorRef = useRef<() => void>(undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        nextErrorRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const replay = useMutation({
    mutationFn: () => api.replayTrace(traceId),
    onSuccess: (result) => {
      toast.success(result.traceId ? `Replay recorded — trace ${result.traceId}` : "Replay complete");
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
    onError: (e) => toast.error(`Replay failed: ${String(e)}`),
  });

  if (isLoading)
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (error)
    return (
      <EmptyState
        title="Couldn’t load this trace"
        description={error instanceof Error ? error.message : String(error)}
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RotateCcw className="size-3.5" />
            Try again
          </Button>
        }
      />
    );
  if (!trace) return <EmptyState title="Trace not found" description="It may have been deleted, or the id is wrong." />;

  const payloadObs = visibleObservations(trace.observations);
  const payloadIds = new Set(payloadObs.map((o) => o.id));
  const showGraph = obsView === "graph";
  // The detail pane defaults to the first failing observation (what you're usually here for),
  // else the first payload-bearing one. A stale selection from a previous trace falls back here.
  const effectiveSelected =
    selectedId && payloadIds.has(selectedId)
      ? selectedId
      : (payloadObs.find((o) => o.level === "ERROR")?.id ?? payloadObs[0]?.id);
  const selectedObs = payloadObs.find((o) => o.id === effectiveSelected);
  // Scores are shown as individual records, newest first — no averaging, so a metric's value never
  // disagrees with itself across panels (the top annotation row matches Human review's highlight).
  const sortedScores = [...trace.scores].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const errorObsIds = trace.observations.filter((o) => o.level === "ERROR").map((o) => o.id);
  const errorCount = errorObsIds.length;
  const warningCount = trace.observations.filter((o) => o.level === "WARNING").length;

  // Waterfall collapse/expand + failed-path highlight (small traces → recompute per render).
  const failedPath = failedPathIds(trace.observations);
  const collapsible = collapsibleIds(trace.observations);
  const allCollapsed = collapsible.size > 0 && [...collapsible].every((id) => collapsed.has(id));
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Select an observation's payload into the detail pane. `block: "nearest"` is a no-op when the
  // pane is already on screen (wide, side-by-side) and scrolls it into view when it's stacked below.
  const selectObs = (id: string) => {
    if (!payloadIds.has(id)) return;
    setSelectedId(id);
    requestAnimationFrame(() =>
      payloadPanelRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" }),
    );
  };

  // Accelerator: step through failing observations (click the "N errors" badge or press E),
  // selecting each into the detail pane and scrolling its waterfall row into view.
  const jumpToNextError = () => {
    if (errorObsIds.length === 0) return;
    const cur = errorObsIds.indexOf(effectiveSelected ?? "");
    const next = errorObsIds[(cur + 1) % errorObsIds.length]!;
    setSelectedId(next);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-obs-row="${CSS.escape(next)}"]`)
        ?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      payloadPanelRef.current?.scrollIntoView({ block: "nearest" });
    });
  };
  nextErrorRef.current = jumpToNextError;

  return (
    // Cap the content width so cards stop sprawling on wide monitors (the value column of a
    // key/value table shouldn't run 2000px from its label). Inert inside the peek drawer, which
    // is already narrower than this cap.
    <div className="mx-auto w-full max-w-[1600px] space-y-6">
      {showBreadcrumb && (
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/traces">Traces</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[40ch] truncate">{trace.name || trace.id}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{trace.name || trace.id}</h1>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="font-mono text-xs">{trace.id}</span>
            <CopyButton value={trace.id} label="trace id" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {errorCount > 0 && (
            <button
              type="button"
              onClick={jumpToNextError}
              title="Jump to next error (E)"
              className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <KindBadge tone="red" className="cursor-pointer hover:bg-destructive/20">
                {errorCount} error{errorCount > 1 ? "s" : ""}
              </KindBadge>
            </button>
          )}
          {warningCount > 0 && (
            <KindBadge tone="amber">
              {warningCount} warning{warningCount > 1 ? "s" : ""}
            </KindBadge>
          )}
          <Badge variant="secondary" className="font-medium">
            {trace.environment}
          </Badge>
          <FlagForReviewButton traceId={trace.id} />
          <Button variant="outline" size="sm" disabled={readOnly || replay.isPending} onClick={() => replay.mutate()}>
            <RotateCcw className="size-3.5" />
            {replay.isPending ? "Replaying…" : "Replay"}
          </Button>
        </div>
      </div>

      <MetricsGrid trace={trace} />

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Trace metadata and linked entities.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid max-w-3xl grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 text-sm">
            {trace.user_id && (
              <>
                <dt className="text-muted-foreground">User</dt>
                <dd className="font-mono text-xs">{trace.user_id}</dd>
              </>
            )}
            {trace.session_id && (
              <>
                <dt className="text-muted-foreground">Session</dt>
                <dd className="flex items-center gap-1">
                  <Link
                    to="/sessions/$id"
                    params={{ id: trace.session_id }}
                    className="truncate font-mono text-xs text-primary hover:underline"
                  >
                    {trace.session_id}
                  </Link>
                  <CopyButton value={trace.session_id} label="session id" />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Tags</dt>
            <dd>
              <TagEditor traceId={trace.id} tags={trace.tags} />
            </dd>
          </dl>
          <MediaPreview raw={trace.input} />
          <MediaPreview raw={trace.output} />
          {/* Surface truncated trace payloads (otherwise the Details card shows only metadata/media). */}
          {truncatedMarker(trace.input) && <PayloadView raw={trace.input} />}
          {truncatedMarker(trace.output) && <PayloadView raw={trace.output} />}
        </CardContent>
      </Card>

      <InlineReview traceId={trace.id} scores={trace.scores} />

      <Card>
        <CardHeader>
          <CardTitle>Scores ({trace.scores.length})</CardTitle>
          <CardDescription>Evaluations and annotations recorded on this trace, newest first.</CardDescription>
          <CardAction>
            <AnnotateButton traceId={trace.id} />
          </CardAction>
        </CardHeader>
        <CardContent className={sortedScores.length === 0 ? undefined : "px-0"}>
          {sortedScores.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">
              No scores yet. Use <span className="font-medium">Annotate</span> to record human feedback.
            </p>
          ) : (
            // One row per score record (not aggregated) so every value is shown with its own
            // timestamp — nothing is averaged into a single number that could contradict itself.
            <div className="max-h-96 overflow-auto border-t">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 py-1.5 text-left font-medium">Source</th>
                    <th className="px-2 py-1.5 text-left font-medium">Metric</th>
                    <th className="px-2 py-1.5 text-right font-medium">Value</th>
                    <th className="px-4 py-1.5 text-right font-medium">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedScores.map((s, i) => {
                    const value = s.value != null ? String(s.value) : s.string_value || "—";
                    const comment = s.comment && !looksJson(s.comment) ? s.comment : "";
                    return (
                      <tr key={`${s.source}:${s.name}:${s.timestamp}:${i}`} className="border-t align-top">
                        <td className="px-4 py-2">
                          <KindBadge tone={toneForSource(s.source)}>{s.source.toLowerCase()}</KindBadge>
                        </td>
                        <td className="px-2 py-2">
                          <div className="font-medium">{s.name}</div>
                          {comment && (
                            <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground" title={comment}>
                              {comment}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-medium tabular-nums whitespace-nowrap">{value}</td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums whitespace-nowrap text-muted-foreground">
                          {s.timestamp.slice(0, 16).replace("T", " ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timeline + payload as a master-detail split. The breakpoint is container-based (not
          viewport) and set above the peek drawer's max width, so the drawer always stacks and only
          the wide full-page route goes side-by-side. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @6xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] @6xl:items-start">
          <Card>
            <CardHeader>
              <CardTitle>Observations ({trace.observation_count})</CardTitle>
              <CardDescription>
                {showGraph
                  ? "Agent-flow graph derived from the observation tree — nodes are colored by type."
                  : "Execution timeline for this trace — select a row to inspect its payload."}
                {!showGraph && errorCount > 0 && " Branches leading to a failure are accented in red."}
              </CardDescription>
              <CardAction className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                  <Button
                    variant={obsView === "timeline" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setObsView("timeline")}
                  >
                    Timeline
                  </Button>
                  <Button
                    variant={obsView === "graph" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setObsView("graph")}
                  >
                    Graph
                  </Button>
                </div>
                {!showGraph && collapsible.size > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(collapsible))}
                  >
                    {allCollapsed ? "Expand all" : "Collapse all"}
                  </Button>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className={showGraph ? undefined : "px-0"}>
              {showGraph ? (
                <TraceGraph observations={trace.observations} />
              ) : trace.observations.length === 0 ? (
                <div className="px-6">
                  <EmptyState title="No observations." />
                </div>
              ) : (
                <div className="overflow-x-auto border-t">
                  <div
                    className={`grid ${WATERFALL_COLS} border-b bg-muted/30 py-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase`}
                  >
                    <span className="px-3">Observation</span>
                    <span className="inline-flex items-center gap-1">
                      Timeline
                      <HelpTip>
                        Each bar's position is its start offset within the trace; its length is the duration.
                      </HelpTip>
                    </span>
                    <span className="pr-3 text-right">Duration</span>
                  </div>
                  {layout(trace.observations, collapsed, failedPath).map((obs) => (
                    <WaterfallRow
                      key={obs.id}
                      obs={obs}
                      selected={obs.id === effectiveSelected}
                      onSelect={payloadIds.has(obs.id) ? () => selectObs(obs.id) : undefined}
                      onToggle={() => toggleCollapse(obs.id)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Detail pane: sticky beside the timeline on wide screens, stacked below it otherwise. */}
          <div ref={payloadPanelRef} className="scroll-mt-20 @6xl:sticky @6xl:top-16">
            <Card className="@6xl:max-h-[calc(100dvh-6rem)] @6xl:overflow-auto">
              <CardHeader>
                <CardTitle>Payload</CardTitle>
                <CardDescription>Input and output for the selected observation.</CardDescription>
              </CardHeader>
              <CardContent>
                {selectedObs ? (
                  <ObservationDetailPanel obs={selectedObs} />
                ) : (
                  <EmptyState title="No payloads to show." />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <SimilarTraces traceId={trace.id} />

      <Comments traceId={trace.id} />
    </div>
  );
}

function Comments({ traceId }: { traceId: string }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: comments } = useQuery({
    queryKey: ["comments", traceId],
    queryFn: () => api.listComments("TRACE", traceId),
  });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.createComment("TRACE", traceId, text),
    onSuccess: () => {
      setText("");
      toast.success("Comment posted");
      qc.invalidateQueries({ queryKey: ["comments", traceId] });
    },
    onError: (e) => toast.error(`Failed to post comment: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteComment(id),
    onSuccess: () => {
      toast.success("Comment deleted");
      qc.invalidateQueries({ queryKey: ["comments", traceId] });
    },
    onError: (e) => toast.error(`Failed to delete comment: ${String(e)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comments ({comments?.length ?? 0})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {comments && comments.length > 0 && (
          <ul className="space-y-3">
            {comments.map((cm) => (
              <li key={cm.id} className="border bg-background p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {cm.author} · {cm.createdAt.slice(0, 19).replace("T", " ")}
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        disabled={readOnly || remove.isPending}
                        aria-label="Delete comment"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently deletes the comment. It can’t be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep comment</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => remove.mutate(cm.id)}>
                          Delete comment
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                <div className="mt-1 text-sm">{cm.content}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <Textarea
            placeholder="Add a comment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text) add.mutate();
            }}
            rows={3}
          />
          <Button disabled={readOnly || !text || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? "Posting…" : "Comment"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
