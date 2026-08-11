import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Gauge, Sigma } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState } from "../components/empty-state";
import { HelpTip } from "../components/help-tip";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { StatTile } from "../components/stat-tile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { api, type ScoreAgreement } from "../lib/api";
import { useRangeDays } from "../lib/timeRange";
import { cn } from "../lib/utils";

/**
 * Score analytics — the surface that answers "is this score trustworthy?".
 *
 * The left half describes ONE score (shape, spread, movement). The right half compares TWO
 * score sources over the traces carrying both: human vs judge, judge vs judge, v1 vs v2 of a
 * judge. That comparison is how a team establishes a judge can be relied on, which is why the
 * agreement statistics — correlation / MAE / RMSE for numbers, agreement rate / Cohen's Kappa /
 * per-label F1 for labels — sit next to a confusion matrix rather than in a separate report.
 */

interface ScoreSearch {
  name?: string;
  compare?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const Route = createFileRoute("/scores")({
  validateSearch: (s: Record<string, unknown>): ScoreSearch => ({
    name: str(s.name),
    compare: str(s.compare),
  }),
  component: ScoresPage,
});

const histogramConfig = { count: { label: "Scores", color: "var(--chart-1)" } } satisfies ChartConfig;
const timelineConfig = { mean: { label: "Mean", color: "var(--chart-2)" } } satisfies ChartConfig;

const num = (n: number) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—");

/** Kappa's conventional reading, so a bare number isn't left to interpretation. */
function kappaLabel(k: number): { text: string; tone: "green" | "teal" | "amber" | "red" } {
  if (k >= 0.8) return { text: "almost perfect", tone: "green" };
  if (k >= 0.6) return { text: "substantial", tone: "teal" };
  if (k >= 0.4) return { text: "moderate", tone: "amber" };
  if (k >= 0.2) return { text: "fair", tone: "amber" };
  return { text: "slight or none", tone: "red" };
}

/** Confusion matrix as a heatmap: rows = the first score's value, columns = the second's. */
function ConfusionMatrix({ data }: { data: ScoreAgreement }) {
  const cell = new Map(data.matrix.map((c) => [`${c.a}␟${c.b}`, c.count]));
  const max = Math.max(1, ...data.matrix.map((c) => c.count));
  if (data.aLabels.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left font-medium text-muted-foreground">
              {data.a} ↓ / {data.b} →
            </th>
            {data.bLabels.map((b) => (
              <th key={b} className="p-1 font-medium text-muted-foreground">
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.aLabels.map((a) => (
            <tr key={a}>
              <td className="whitespace-nowrap p-1 font-medium text-muted-foreground">{a}</td>
              {data.bLabels.map((b) => {
                const count = cell.get(`${a}␟${b}`) ?? 0;
                // The diagonal is agreement; everything off it is where the two sources part ways.
                const agree = a === b;
                return (
                  <td key={b} className="p-0.5">
                    <div
                      className={cn(
                        "flex h-9 w-16 items-center justify-center rounded-sm tabular-nums",
                        agree ? "bg-primary/15" : "bg-destructive/10",
                        count === 0 && "bg-muted/40 text-muted-foreground",
                      )}
                      style={count > 0 ? { opacity: 0.35 + 0.65 * (count / max) } : undefined}
                      title={`${data.a}=${a}, ${data.b}=${b}: ${count}`}
                    >
                      {count}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScoresPage() {
  const { name, compare } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const days = useRangeDays();

  const { data: names } = useQuery({
    queryKey: ["score-names", days],
    queryFn: () => api.listScoreNames(days),
    placeholderData: keepPreviousData,
  });
  // Default to the most-recorded score rather than making the page start empty.
  const selected = name ?? names?.[0]?.name;

  const { data: dist, isLoading } = useQuery({
    queryKey: ["score-distribution", selected, days],
    queryFn: () => api.getScoreDistribution(selected as string, days),
    enabled: !!selected,
    placeholderData: keepPreviousData,
  });
  const { data: agreement } = useQuery({
    queryKey: ["score-agreement", selected, compare, days],
    queryFn: () => api.getScoreAgreement(selected as string, compare as string, days),
    enabled: !!selected && !!compare,
    placeholderData: keepPreviousData,
  });

  const setParam = (key: keyof ScoreSearch, value: string) =>
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined }) });

  if (names && names.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Scores" description="Distributions, trends, and agreement between score sources." />
        <EmptyState
          icon={Gauge}
          title="No scores yet"
          description="Scores appear once an evaluator runs, someone annotates a trace, or your SDK sends one."
        />
      </div>
    );
  }

  const categorical = (dist?.categories.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Scores"
        description="Distributions, trends, and agreement between two score sources."
        help="Pick a score to see how its values are distributed and how they move over time. Pick a second score to compare the two sources — that's how you find out whether a judge agrees with your humans."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium">Score</div>
          <Select value={selected ?? ""} onValueChange={(v) => setParam("name", v)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Pick a score" />
            </SelectTrigger>
            <SelectContent>
              {(names ?? []).map((n) => (
                <SelectItem key={n.name} value={n.name}>
                  {n.name} ({n.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1 text-sm font-medium">
            Compare with
            <HelpTip>
              Compares the two scores over the traces that carry BOTH. Use it to check a judge against human
              annotations, one judge against another, or v1 of a judge against v2.
            </HelpTip>
          </div>
          <Select value={compare ?? "__none"} onValueChange={(v) => setParam("compare", v === "__none" ? "" : v)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="(none)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">(none)</SelectItem>
              {(names ?? [])
                .filter((n) => n.name !== selected)
                .map((n) => (
                  <SelectItem key={n.name} value={n.name}>
                    {n.name} ({n.count})
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        {dist && <KindBadge tone="neutral">{dist.dataType || "unknown"}</KindBadge>}
      </div>

      {isLoading || !dist ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Scores" value={dist.stats.count.toLocaleString()} icon={Sigma} help="Rows in range." />
            <StatTile label="Mean" value={num(dist.stats.mean)} help="Average of the numeric values." />
            <StatTile label="Median (p50)" value={num(dist.stats.p50)} help="Half the scores fall below this." />
            <StatTile
              label="Std dev"
              value={num(dist.stats.stddev)}
              help="Spread of the values. Near zero means the score barely discriminates."
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Distribution</CardTitle>
                <CardDescription>
                  {categorical ? "How often each label was recorded." : "How the values spread across the range."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {categorical ? (
                  <table className="w-full text-sm">
                    <tbody>
                      {dist.categories.map((c) => (
                        <tr key={c.value} className="border-b last:border-0">
                          <td className="py-2 font-medium">{c.value}</td>
                          <td className="py-2 text-right tabular-nums">{c.count.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : dist.histogram.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Every recorded value is identical — there is no range to plot.
                  </p>
                ) : (
                  <ChartContainer config={histogramConfig} className="aspect-auto h-56 w-full">
                    <BarChart data={dist.histogram} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="from"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={6}
                        className="text-[0.625rem]"
                      />
                      <YAxis tickLine={false} axisLine={false} width={32} className="text-[0.625rem]" />
                      <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => `from ${v}`} />} />
                      <Bar dataKey="count" fill="var(--color-count)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Over time</CardTitle>
                <CardDescription>Daily mean — a step here usually means a config change, not drift.</CardDescription>
              </CardHeader>
              <CardContent>
                {dist.timeline.length < 2 ? (
                  <p className="text-sm text-muted-foreground">Not enough days in range to plot a trend.</p>
                ) : (
                  <ChartContainer config={timelineConfig} className="aspect-auto h-56 w-full">
                    <LineChart data={dist.timeline} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={6}
                        tickFormatter={(v: string) => v.slice(5)}
                        className="text-[0.625rem]"
                      />
                      <YAxis tickLine={false} axisLine={false} width={32} className="text-[0.625rem]" />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line
                        type="monotone"
                        dataKey="mean"
                        stroke="var(--color-mean)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {agreement && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span>
                {agreement.a} vs {agreement.b}
              </span>
              <KindBadge tone="neutral">{agreement.pairs.toLocaleString()} paired traces</KindBadge>
              {agreement.sampled && (
                <KindBadge tone="amber">sampled — statistics over the first {agreement.pairs} pairs</KindBadge>
              )}
            </CardTitle>
            <CardDescription>Computed over the traces that carry both scores.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {agreement.pairs === 0 ? (
              <p className="text-sm text-muted-foreground">No trace in range carries both scores.</p>
            ) : (
              <>
                {agreement.numeric && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <StatTile
                      label="Correlation"
                      value={num(agreement.numeric.correlation)}
                      help="Pearson correlation (-1…1). High means the two sources rank traces the same way, even if their absolute values differ."
                    />
                    <StatTile
                      label="MAE"
                      value={num(agreement.numeric.mae)}
                      help="Mean absolute difference between the two scores."
                    />
                    <StatTile
                      label="RMSE"
                      value={num(agreement.numeric.rmse)}
                      help="Root mean squared difference — punishes large disagreements more than MAE."
                    />
                  </div>
                )}
                {agreement.categorical && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <StatTile
                        label="Agreement rate"
                        value={`${Math.round(agreement.categorical.agreementRate * 100)}%`}
                        help="Fraction of paired traces where both sources gave the same label."
                      />
                      <StatTile
                        label="Cohen's Kappa"
                        value={
                          <span className="flex items-center gap-2">
                            {num(agreement.categorical.cohensKappa)}
                            <KindBadge tone={kappaLabel(agreement.categorical.cohensKappa).tone}>
                              {kappaLabel(agreement.categorical.cohensKappa).text}
                            </KindBadge>
                          </span>
                        }
                        help="Agreement corrected for what chance alone would produce. Two raters who always say 'pass' agree 100% of the time and score 0 here."
                      />
                    </div>
                    <div>
                      <div className="mb-2 text-sm font-medium">Per-label F1</div>
                      <table className="w-full max-w-md text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="py-1 font-medium">Label</th>
                            <th className="py-1 text-right font-medium">F1</th>
                            <th className="py-1 text-right font-medium">Support</th>
                          </tr>
                        </thead>
                        <tbody>
                          {agreement.categorical.f1.map((f) => (
                            <tr key={f.label} className="border-b last:border-0">
                              <td className="py-1 font-medium">{f.label}</td>
                              <td className="py-1 text-right tabular-nums">{num(f.f1)}</td>
                              <td className="py-1 text-right tabular-nums">{f.support}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {!agreement.numeric && !agreement.categorical && (
                  <p className="text-sm text-muted-foreground">
                    These two scores don't report comparable values (one is numeric, the other is a label), so only the
                    pair count is meaningful.
                  </p>
                )}
                <div>
                  <div className="mb-2 inline-flex items-center gap-1 text-sm font-medium">
                    Confusion matrix
                    <HelpTip>
                      Rows are {agreement.a}, columns are {agreement.b}. The diagonal is agreement; everything off it is
                      where the two sources part ways. Numeric scores are bucketed first.
                    </HelpTip>
                  </div>
                  <ConfusionMatrix data={agreement} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
