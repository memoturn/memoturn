import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../components/empty-state";
import { HelpTip } from "../components/help-tip";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";

export const Route = createFileRoute("/retrieval")({ component: RetrievalPage });

/** Score-band tone: red below 0.3, amber below 0.6, green above — the usual relevance read. */
function scoreTone(score: number | null): "red" | "amber" | "green" | "neutral" {
  if (score === null) return "neutral";
  if (score < 0.3) return "red";
  if (score < 0.6) return "amber";
  return "green";
}

const fmt = (n: number | null, digits = 3) => (n === null ? "—" : n.toFixed(digits));

function RetrievalPage() {
  const [days, setDays] = useState("7");
  const { data, isLoading, error } = useQuery({
    queryKey: ["retrieval-analytics", days],
    queryFn: () => api.getRetrievalAnalytics({ days: Number(days), limit: 20 }),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) return <EmptyState title="Failed to load retrieval analytics" description={String(error)} />;

  const empty = !data || data.summary.retrievals === 0;
  const maxBucket = Math.max(1, ...(data?.score_histogram.map((b) => b.count) ?? [1]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Retrieval"
        description="RAG quality across traces — which retrievals are scoring badly, and which documents keep coming back."
        help="Aggregated from the documents your RETRIEVER spans returned. The trace view shows what one query retrieved; this shows where retrieval is failing overall."
        actions={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {empty ? (
        <EmptyState
          icon={Search}
          title="No retrievals recorded"
          description="Wrap a vector store (Pinecone, Chroma, Weaviate, Qdrant) with the SDK, or send RETRIEVER spans with retrievedDocuments, and their relevance shows up here."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Retrievals" value={data.summary.retrievals.toLocaleString()} />
            <Stat label="Documents returned" value={data.summary.documents.toLocaleString()} />
            <Stat label="Avg docs per retrieval" value={data.summary.avg_docs_per_retrieval.toFixed(1)} />
            <Stat
              label="Avg top score"
              value={fmt(data.summary.avg_top_score)}
              hint="Mean of each retrieval's best-scoring document — the 'did we find anything?' signal."
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Similarity distribution</CardTitle>
              <CardDescription>
                Every returned document, bucketed by score. A mass piled at the low end means the index isn't matching
                your queries.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex h-40 items-end gap-1.5">
                {Array.from({ length: 10 }, (_, i) => {
                  const bucket = i / 10;
                  const count = data.score_histogram.find((b) => Math.abs(b.bucket - bucket) < 1e-9)?.count ?? 0;
                  const tone = scoreTone(bucket);
                  return (
                    <div key={bucket} className="flex h-full flex-1 flex-col items-center gap-1">
                      <span className="text-[0.625rem] text-muted-foreground">{count || ""}</span>
                      {/* The bar's percentage height only resolves against a parent with a
                          definite height — this flex-1 track inside the h-full column is it. */}
                      <div className="flex w-full flex-1 items-end">
                        <div
                          className={`w-full rounded-t-sm ${
                            tone === "red"
                              ? "bg-destructive/60"
                              : tone === "amber"
                                ? "bg-amber-500/60"
                                : "bg-primary/60"
                          }`}
                          // Proportional to the tallest bucket, with a floor so a single
                          // document is still visible on a low-volume project.
                          style={{ height: `${count > 0 ? Math.max(4, (count / maxBucket) * 100) : 0}%` }}
                          title={`${count} document(s) scoring ${bucket.toFixed(1)}–${(bucket + 0.1).toFixed(1)}`}
                        />
                      </div>
                      <span className="text-[0.625rem] text-muted-foreground">{bucket.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <span className="inline-flex items-center gap-1">
                  Weakest retrievals
                  <HelpTip>
                    Ordered by best-document score, worst first. These are the queries where nothing relevant came back
                    — the place to look when RAG answers go wrong.
                  </HelpTip>
                </span>
              </CardTitle>
              <CardDescription>Click through to the trace to see the query and what it returned.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 pb-2 font-medium">Span</th>
                    <th className="px-3 pb-2 font-medium">When</th>
                    <th className="px-3 pb-2 text-right font-medium">Docs</th>
                    <th className="px-3 pb-2 text-right font-medium">Top score</th>
                    <th className="px-3 pb-2 text-right font-medium">Mean</th>
                    <th className="px-3 pb-2 font-medium">Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {data.weakest.map((w) => (
                    <tr key={w.observation_id} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        {w.name || <span className="text-muted-foreground">retrieval</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {w.timestamp.replace("T", " ").replace("Z", "")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{w.doc_count}</td>
                      <td className="px-3 py-2 text-right">
                        <KindBadge tone={scoreTone(w.top_score)}>{fmt(w.top_score)}</KindBadge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmt(w.mean_score)}</td>
                      <td className="px-3 py-2">
                        <Link
                          to="/traces/$id"
                          params={{ id: w.trace_id }}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {w.trace_id.slice(0, 12)}…
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {data.documents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Most-retrieved documents</CardTitle>
                <CardDescription>
                  A document returned constantly but scoring low is usually a chunking problem, not a relevance one.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 pb-2 font-medium">Document</th>
                      <th className="px-3 pb-2 text-right font-medium">Retrievals</th>
                      <th className="px-3 pb-2 text-right font-medium">Avg score</th>
                      <th className="px-3 pb-2 text-right font-medium">Avg rank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.documents.map((d) => (
                      <tr key={d.doc_id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{d.doc_id}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{d.retrievals.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">
                          <KindBadge tone={scoreTone(d.avg_score)}>{fmt(d.avg_score)}</KindBadge>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {d.avg_rank.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {label}
          {hint && <HelpTip>{hint}</HelpTip>}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
