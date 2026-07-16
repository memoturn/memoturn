import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

const fmtCost = (n: number) => (n > 0 ? `$${n.toFixed(n < 0.01 ? 4 : 2)}` : "—");

/**
 * "Find similar traces" — semantic nearest-neighbour over the project's stored embeddings,
 * seeded by this trace. Runs on demand (a scan, not free) rather than auto-fetching, so
 * opening a trace never triggers it. Results are ranked by cosine similarity in [0, 1].
 */
export function SimilarTraces({ traceId }: { traceId: string }) {
  const [enabled, setEnabled] = useState(false);
  const {
    data = [],
    isFetching,
    error,
  } = useQuery({
    queryKey: ["trace-similar", traceId],
    queryFn: () => api.findSimilarTraces(traceId, { limit: 10 }),
    enabled,
    staleTime: 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Similar traces</CardTitle>
        <CardDescription>Nearest matches by embedding — traces whose content means the same thing.</CardDescription>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <Button variant="outline" size="sm" onClick={() => setEnabled(true)}>
            <Sparkles className="size-3.5" />
            Find similar traces
          </Button>
        ) : isFetching ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">Couldn’t compute similarity: {String(error)}</p>
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No similar traces found. This trace may have no embeddings, or nothing else is close.
          </p>
        ) : (
          <ul className="divide-y">
            {data.map((t) => {
              const pct = Math.max(0, Math.round(t.similarity * 100));
              return (
                <li key={t.id}>
                  <Link
                    to="/traces/$id"
                    params={{ id: t.id }}
                    className="flex items-center gap-3 py-2 transition-colors hover:bg-accent/40"
                  >
                    <span className="flex w-11 shrink-0 justify-center">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
                        {pct}%
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.name || t.id}</span>
                      <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground">{t.id}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      <span className="block">{fmtCost(t.total_cost)}</span>
                      <span className="block">{t.observation_count} obs</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
