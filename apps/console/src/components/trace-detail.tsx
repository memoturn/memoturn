import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Flag, FlaskConical, Plus, RotateCcw, Tag, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { KindBadge, type KindBadgeTone, toneForKind } from "./kind-badge";
import { ProviderIcon } from "./provider-icon";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
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

type ScoreLike = { source: string; name: string; value: number | null; string_value: string; comment: string };

/** Collapse duplicate scores (same source+name) into one chip: numeric → avg, else latest category. */
function aggregateTraceScores(scores: ScoreLike[]) {
  const groups = new Map<
    string,
    { source: string; name: string; vals: number[]; str: string; comment: string; count: number }
  >();
  for (const s of scores) {
    const key = `${s.source}::${s.name}`;
    const g = groups.get(key) ?? { source: s.source, name: s.name, vals: [], str: "", comment: "", count: 0 };
    g.count++;
    if (s.value != null) g.vals.push(s.value);
    else if (s.string_value) g.str = s.string_value;
    if (!g.comment && s.comment && !looksJson(s.comment)) g.comment = s.comment;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    source: g.source,
    name: g.name,
    count: g.count,
    comment: g.comment,
    display: g.vals.length
      ? Number((g.vals.reduce((a, b) => a + b, 0) / g.vals.length).toFixed(2)).toString()
      : g.str || "—",
  }));
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

interface Laid extends ObservationDetail {
  depth: number;
  offsetPct: number;
  widthPct: number;
  startOffsetMs: number;
}

/** Compute waterfall layout: depth from parent chain, bar offset/width from times. */
function layout(observations: ObservationDetail[]): Laid[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const depthOf = (o: ObservationDetail): number => {
    let d = 0;
    let cur: ObservationDetail | undefined = o;
    const seen = new Set<string>();
    while (cur?.parent_observation_id && byId.has(cur.parent_observation_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_observation_id);
      d++;
    }
    return d;
  };

  const starts = observations.map((o) => ms(o.start_time) ?? 0);
  // end_time can be coarser than latency_ms (second precision), so trust whichever runs longer
  const ends = observations.map((o, i) => Math.max(ms(o.end_time) ?? 0, starts[i]! + Number(o.latency_ms)));
  const traceStart = Math.min(...starts);
  const total = Math.max(1, Math.max(...ends) - traceStart);

  return observations
    .map((o, i) => {
      const offsetPct = Math.min(((starts[i]! - traceStart) / total) * 100, 98.5);
      const widthPct = Math.max(1.5, Math.min((Number(o.latency_ms) / total) * 100, 100 - offsetPct));
      return { ...o, depth: depthOf(o), offsetPct, widthPct, startOffsetMs: starts[i]! - traceStart };
    })
    .sort((a, b) => (ms(a.start_time) ?? 0) - (ms(b.start_time) ?? 0));
}

/** Bar hues match the KindBadge tones (blue = generation, emerald = span, amber = event). */
function barColor(type: string): string {
  if (type === "GENERATION") return "bg-blue-500";
  if (type === "SPAN") return "bg-emerald-500";
  return "bg-amber-500";
}

/** Human duration: sub-second in ms, otherwise seconds (2 sig figs). */
function fmtDuration(msVal: number): string {
  return msVal >= 1000 ? `${(msVal / 1000).toFixed(2)}s` : `${msVal} ms`;
}

const WATERFALL_COLS = "grid-cols-[minmax(220px,300px)_1fr_5.5rem]";

function WaterfallRow({ obs, onSelect }: { obs: Laid; onSelect?: () => void }) {
  const label = `${obs.name || obs.id.slice(0, 8)}${obs.model ? ` · ${obs.model}` : ""}`;
  // Errors/warnings tint the whole row so failures pop while scanning the waterfall.
  const tint =
    obs.level === "ERROR"
      ? "bg-destructive/5 hover:bg-destructive/10"
      : obs.level === "WARNING"
        ? "bg-amber-500/5 hover:bg-amber-500/10"
        : "hover:bg-muted/40";
  const bar = obs.level === "ERROR" ? "bg-destructive" : barColor(obs.type);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: interactive only when onSelect is set, where role/tabIndex/onKeyDown are all provided
    <div
      className={`group grid ${WATERFALL_COLS} items-center border-b transition-colors last:border-b-0 ${tint} ${onSelect ? "cursor-pointer" : ""}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
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
        {/* Tree guides — one faint vertical rule per ancestor depth. */}
        {Array.from({ length: obs.depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute inset-y-0 w-px bg-border/70"
            style={{ left: `${18 + i * 16}px` }}
          />
        ))}
        <div className="flex min-w-0 items-center gap-1.5">
          <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>
          <span className="truncate font-medium">{obs.name || obs.id.slice(0, 8)}</span>
          {obs.model && (
            <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <ProviderIcon provider={obs.provider} model={obs.model} size={13} />
              {obs.model}
            </span>
          )}
          {obs.level !== "DEFAULT" && <KindBadge tone={toneForLevel(obs.level)}>{obs.level.toLowerCase()}</KindBadge>}
        </div>
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
      <span className="py-2 pr-3 text-right text-xs tabular-nums text-muted-foreground">
        {fmtDuration(obs.latency_ms)}
      </span>
    </div>
  );
}

function visibleObservations(observations: ObservationDetail[]): ObservationDetail[] {
  return observations.filter((obs) => obs.input || obs.output || obs.level !== "DEFAULT");
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

function ObservationDetailItem({
  obs,
  registerRef,
}: {
  obs: ObservationDetail;
  registerRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <AccordionItem value={obs.id} ref={registerRef} className="scroll-mt-20">
      <AccordionTrigger>
        <div className="flex flex-wrap items-center gap-2">
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
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Tag className="size-3" />
              {obs.prompt_id}
              {obs.prompt_version ? ` v${obs.prompt_version}` : ""}
            </Link>
          )}
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3">
        {obs.type === "GENERATION" && obs.input && (
          <div className="flex justify-end">
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
        {obs.status_message && (
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Status</div>
            <pre className={PRE_CLASS}>{obs.status_message}</pre>
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN";

type AnnotationPatch = { value?: number; stringValue?: string };

/** Numeric annotation via a native range slider; submits the value on pointer release. */
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
  const step = max - min <= 1 ? 0.01 : 1;
  const [val, setVal] = useState<number>(active?.value ?? min);
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        disabled={disabled}
        onChange={(e) => setVal(Number(e.target.value))}
        onPointerUp={() => onSubmit({ value: val })}
        onKeyUp={() => onSubmit({ value: val })}
        className="h-1.5 flex-1 cursor-pointer accent-primary"
        aria-label={`${cfg.name} score`}
      />
      <span className="w-10 text-right text-sm font-medium tabular-nums">{val}</span>
    </div>
  );
}

/** One score-config row: category buttons, pass/fail, or a numeric slider. */
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{cfg.name}</span>
        {active && (
          <span className="text-xs text-muted-foreground">
            current:{" "}
            <span className="tabular-nums text-foreground">{active.value ?? (active.string_value || "—")}</span>
          </span>
        )}
      </div>
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

  // Latest ANNOTATION score per config name → the "current" value shown as active.
  const current = new Map<string, ScoreRow>();
  for (const s of scores) if (s.source === "ANNOTATION") current.set(s.name, s);

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
              onClick={() => save.mutate(tags.filter((x) => x !== t))}
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

  const items: { label: string; value: ReactNode }[] = [
    { label: "Start", value: trace.timestamp.replace("T", " ").replace("Z", "") },
    { label: "Duration", value: `${trace.latency_ms} ms` },
    { label: "Observations", value: trace.observation_count.toLocaleString() },
    { label: "Total tokens", value: Number(trace.total_tokens).toLocaleString() },
    { label: "Prompt tokens", value: prompt.toLocaleString() },
    { label: "Completion tokens", value: completion.toLocaleString() },
    ...(cacheRead > 0 ? [{ label: "Cache read", value: cacheRead.toLocaleString() }] : []),
    ...(cacheCreation > 0 ? [{ label: "Cache write", value: cacheCreation.toLocaleString() }] : []),
    { label: "Est. cost", value: cost > 0 ? `$${cost.toFixed(6)}` : "—" },
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
              <dt className="text-xs text-muted-foreground">{it.label}</dt>
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
  // Payloads accordion open state + scroll targets, so clicking a waterfall row jumps here.
  const [openPayloads, setOpenPayloads] = useState<string[]>([]);
  const payloadRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => api.getTrace(traceId),
    // Keep the current trace on screen while the next one loads (smooth J/K stepping in the drawer).
    placeholderData: keepPreviousData,
  });

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
  if (error) return <EmptyState title="Failed to load trace" description={String(error)} />;
  if (!trace) return <EmptyState title="Trace not found" />;

  const payloadObs = visibleObservations(trace.observations);
  const payloadIds = new Set(payloadObs.map((o) => o.id));
  const errorCount = trace.observations.filter((o) => o.level === "ERROR").length;
  const warningCount = trace.observations.filter((o) => o.level === "WARNING").length;

  // Open (if collapsed) and scroll to an observation's payload — driven from the waterfall + graph.
  const selectObs = (id: string) => {
    if (!payloadIds.has(id)) return;
    setOpenPayloads((prev) => (prev.includes(id) ? prev : [...prev, id]));
    requestAnimationFrame(() => payloadRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return (
    <div className="space-y-6">
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
            <KindBadge tone="red">
              {errorCount} error{errorCount > 1 ? "s" : ""}
            </KindBadge>
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
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 text-sm">
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
          <CardDescription>Evaluations and annotations recorded on this trace.</CardDescription>
          <CardAction>
            <AnnotateButton traceId={trace.id} />
          </CardAction>
        </CardHeader>
        <CardContent>
          {trace.scores.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {aggregateTraceScores(trace.scores).map((s) => (
                <div
                  key={`${s.source}::${s.name}`}
                  className="flex items-center justify-between gap-3 border bg-background p-3"
                  title={s.comment || undefined}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <KindBadge tone={toneForSource(s.source)}>{s.source.toLowerCase()}</KindBadge>
                      <span className="truncate text-xs font-medium">{s.name}</span>
                      {s.count > 1 && (
                        <span className="border px-1 text-[0.625rem] tabular-nums text-muted-foreground">
                          ×{s.count}
                        </span>
                      )}
                    </div>
                    {s.comment && <p className="truncate text-xs text-muted-foreground">{s.comment}</p>}
                  </div>
                  <span className="shrink-0 text-2xl font-semibold tabular-nums">{s.display}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No scores yet. Use <span className="font-medium">Annotate</span> to record human feedback.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Observations ({trace.observation_count})</CardTitle>
          <CardDescription>Execution timeline for this trace — click a row to jump to its payload.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {trace.observations.length === 0 ? (
            <div className="px-6">
              <EmptyState title="No observations." />
            </div>
          ) : (
            <div className="overflow-x-auto border-t">
              <div
                className={`grid ${WATERFALL_COLS} border-b bg-muted/30 py-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase`}
              >
                <span className="px-3">Observation</span>
                <span>Timeline</span>
                <span className="pr-3 text-right">Duration</span>
              </div>
              {layout(trace.observations).map((obs) => (
                <WaterfallRow
                  key={obs.id}
                  obs={obs}
                  onSelect={payloadIds.has(obs.id) ? () => selectObs(obs.id) : undefined}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payloads</CardTitle>
          <CardDescription>Inputs and outputs captured per observation.</CardDescription>
        </CardHeader>
        <CardContent className={payloadObs.length === 0 ? undefined : "px-0"}>
          {payloadObs.length === 0 ? (
            <EmptyState title="No payloads to show." />
          ) : (
            <Accordion type="multiple" value={openPayloads} onValueChange={setOpenPayloads} className="border-t px-6">
              {payloadObs.map((obs) => (
                <ObservationDetailItem
                  key={obs.id}
                  obs={obs}
                  registerRef={(el) => {
                    payloadRefs.current[obs.id] = el;
                  }}
                />
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    disabled={readOnly || remove.isPending}
                    onClick={() => remove.mutate(cm.id)}
                    aria-label="Delete comment"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
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
