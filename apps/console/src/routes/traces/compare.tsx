import type { TraceDetail } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "../../components/empty-state";
import { TraceDetailBody } from "../../components/trace-detail";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

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
          {qa.data && qb.data ? <CompareStrip a={qa.data} b={qb.data} /> : <Skeleton className="h-32 w-full" />}

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
