import type { ObservationDetail, TraceDetail } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/empty-state";
import { SideBySideDiff } from "../../components/side-by-side-diff";
import { TraceDetailBody } from "../../components/trace-detail";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { api } from "../../lib/api";
import { normalizeJson } from "../../lib/diff";

type PayloadField = "input" | "output" | "metadata";
const PAYLOAD_FIELDS: PayloadField[] = ["input", "output", "metadata"];

/** Short label for an observation in a picker (name/type + model). */
function obsLabel(o: ObservationDetail): string {
  const base = o.name || o.type || o.id.slice(0, 8);
  return o.model ? `${base} · ${o.model}` : base;
}

interface CompareSearch {
  a?: string;
  b?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const Route = createFileRoute("/traces/compare")({
  validateSearch: (s: Record<string, unknown>): CompareSearch => ({ a: str(s.a), b: str(s.b) }),
  component: ComparePage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

/** A ← delta → B for a numeric metric; the delta is colored by direction (neutral at 0). */
function DeltaRow({ label, a, b, fmt }: { label: string; a: number; b: number; fmt?: (n: number) => string }) {
  const f = fmt ?? ((n: number) => n.toLocaleString());
  const delta = b - a;
  const sign = delta > 0 ? "+" : "";
  const tone = delta === 0 ? "text-muted-foreground" : delta > 0 ? "text-destructive" : "text-primary";
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5 text-muted-foreground">{label}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{f(a)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{f(b)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>{delta === 0 ? "—" : `${sign}${f(delta)}`}</td>
    </tr>
  );
}

/** Pick one observation from each trace and diff a chosen payload field — span-level compare. */
function ObservationDiff({ a, b }: { a: TraceDetail; b: TraceDetail }) {
  const obsA = a.observations;
  const obsB = b.observations;
  // Default pairing: align by observation name (fall back to the first on the B side).
  const matchB = (aObs: ObservationDetail | undefined) =>
    (aObs && obsB.find((o) => o.name === aObs.name)?.id) || obsB[0]?.id || "";
  const [aId, setAId] = useState(obsA[0]?.id ?? "");
  const [bId, setBId] = useState(matchB(obsA[0]));
  const [field, setField] = useState<PayloadField>("output");

  if (obsA.length === 0 || obsB.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">One of the traces has no observations to diff.</p>;
  }
  const selA = obsA.find((o) => o.id === aId) ?? obsA[0]!;
  const selB = obsB.find((o) => o.id === bId) ?? obsB[0]!;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1 text-xs">
          <span className="text-muted-foreground">A · observation</span>
          <Select
            value={aId}
            onValueChange={(v) => {
              setAId(v);
              setBId(matchB(obsA.find((o) => o.id === v))); // re-align B to the newly picked A
            }}
          >
            <SelectTrigger className="h-8 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {obsA.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {obsLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 text-xs">
          <span className="text-muted-foreground">B · observation</span>
          <Select value={bId} onValueChange={setBId}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {obsB.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {obsLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1">
          {PAYLOAD_FIELDS.map((f) => (
            <Button
              key={f}
              variant={field === f ? "default" : "outline"}
              size="sm"
              className="capitalize"
              onClick={() => setField(f)}
            >
              {f}
            </Button>
          ))}
        </div>
      </div>
      <SideBySideDiff
        left={normalizeJson(selA[field] ?? "")}
        right={normalizeJson(selB[field] ?? "")}
        leftLabel={`A · ${obsLabel(selA)}`}
        rightLabel={`B · ${obsLabel(selB)}`}
      />
    </div>
  );
}

/** Tabbed side-by-side content diff — trace-level payloads plus a span-level observation diff. */
function ContentDiff({ a, b }: { a: TraceDetail; b: TraceDetail }) {
  const fields = [
    { key: "input", label: "Input", a: a.input, b: b.input },
    { key: "output", label: "Output", a: a.output, b: b.output },
    { key: "metadata", label: "Metadata", a: a.metadata, b: b.metadata },
  ] as const;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Content diff</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="input">
          <TabsList>
            {fields.map((f) => (
              <TabsTrigger key={f.key} value={f.key}>
                {f.label}
              </TabsTrigger>
            ))}
            <TabsTrigger value="observations">Observations</TabsTrigger>
          </TabsList>
          {fields.map((f) => (
            <TabsContent key={f.key} value={f.key}>
              <SideBySideDiff
                left={normalizeJson(f.a ?? "")}
                right={normalizeJson(f.b ?? "")}
                leftLabel={`A · ${f.label}`}
                rightLabel={`B · ${f.label}`}
              />
            </TabsContent>
          ))}
          <TabsContent value="observations">
            <ObservationDiff a={a} b={b} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function CompareStrip({ a, b }: { a: TraceDetail; b: TraceDetail }) {
  return (
    <div className="overflow-x-auto border">
      <table className="w-full min-w-[32rem] text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Metric</th>
            <th className="px-3 py-2 text-right font-medium">A</th>
            <th className="px-3 py-2 text-right font-medium">B</th>
            <th className="px-3 py-2 text-right font-medium">Δ (B − A)</th>
          </tr>
        </thead>
        <tbody>
          <DeltaRow label="Observations" a={a.observation_count} b={b.observation_count} />
          <DeltaRow label="Tokens" a={Number(a.total_tokens)} b={Number(b.total_tokens)} />
          <DeltaRow label="Cost" a={Number(a.total_cost)} b={Number(b.total_cost)} fmt={fmtCost} />
          <DeltaRow label="Latency" a={Number(a.latency_ms)} b={Number(b.latency_ms)} fmt={(n) => `${n} ms`} />
        </tbody>
      </table>
    </div>
  );
}

function ComparePage() {
  const { a, b } = Route.useSearch();
  // Same query keys as TraceDetailBody, so these are cache hits (no double fetch).
  const qa = useQuery({ queryKey: ["trace", a], queryFn: () => api.getTrace(a as string), enabled: !!a });
  const qb = useQuery({ queryKey: ["trace", b], queryFn: () => api.getTrace(b as string), enabled: !!b });

  return (
    <div className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/traces">Traces</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Compare</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {!a || !b ? (
        <EmptyState title="Pick two traces" description="Select exactly two traces on the list, then choose Compare." />
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Compare traces</h1>
          {qa.data && qb.data ? (
            <>
              <CompareStrip a={qa.data} b={qb.data} />
              <ContentDiff a={qa.data} b={qb.data} />
            </>
          ) : (
            <Skeleton className="h-32 w-full" />
          )}

          <h2 className="pt-2 text-sm font-semibold text-muted-foreground">Full detail</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {[a, b].map((id, i) => (
              <div key={id} className="min-w-0 space-y-2">
                <div className="flex items-center gap-2 border-b pb-2">
                  <span className="flex size-6 items-center justify-center rounded bg-muted text-xs font-semibold">
                    {i === 0 ? "A" : "B"}
                  </span>
                  <Link
                    to="/traces/$id"
                    params={{ id }}
                    className="truncate font-mono text-xs text-primary hover:underline"
                  >
                    {id}
                  </Link>
                </div>
                <TraceDetailBody traceId={id} showBreadcrumb={false} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
