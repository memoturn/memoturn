import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bar, BarChart, XAxis } from "recharts";
import { api, type TraceFilters } from "../lib/api";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";

const config = { count: { label: "Traces", color: "var(--chart-1)" } } satisfies ChartConfig;

/**
 * Compact trace-volume bar chart above the traces list. Honors the active filters (same as the
 * list), so the bars track the on-screen result set. Hidden until there are ≥ 2 buckets to compare.
 */
export function VolumeHistogram({ filters }: { filters: TraceFilters }) {
  const { data } = useQuery({
    queryKey: ["trace-histogram", filters],
    queryFn: () => api.traceHistogram(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });

  const buckets = data?.buckets ?? [];
  if (buckets.length < 2) return null;

  const total = buckets.reduce((a, b) => a + b.count, 0);
  const hour = data?.interval === "hour";
  // day buckets: "2026-07-12" → "07-12"; hour buckets: "2026-07-12T14:00" → "14:00".
  const tick = (b: string) => (hour ? b.slice(11, 16) : b.slice(5));

  return (
    <div className="rounded-md border bg-card/40 px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>Trace volume</span>
        <span className="tabular-nums">{total.toLocaleString()} in range</span>
      </div>
      <ChartContainer config={config} className="aspect-auto h-14 w-full">
        <BarChart data={buckets} margin={{ top: 2, right: 4, left: 4, bottom: 0 }}>
          <XAxis
            dataKey="bucket"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={32}
            tickFormatter={tick}
            className="text-[0.625rem]"
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent labelFormatter={(v) => String(v).replace("T", " ")} />}
          />
          <Bar dataKey="count" fill="var(--color-count)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
