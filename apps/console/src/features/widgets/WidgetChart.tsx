import type { AnalyticsQuery, ChartType, QueryResult } from "@memoturn/contracts";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";

/**
 * Renders an analytics query result in the chosen chart type. Pure/presentational: it takes the
 * AnalyticsQuery (to know which columns are the x-axis vs the metric) and the QueryResult rows,
 * and dispatches to a Recharts renderer (or a number/table for the non-graph shapes). Reused by
 * the widget builder's live preview and by saved dashboard widgets.
 */

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

const fmtNum = (v: unknown): string =>
  typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v ?? "—");

/** The x-axis key (time bucket or the first dimension) and the primary metric column alias. */
function chartKeys(query: AnalyticsQuery): { xKey: string; metricKey: string } {
  const m = query.metrics[0];
  const metricKey = m ? `${m.aggregation}_${m.measure}` : "value";
  const xKey = query.timeDimension ? "time" : (query.dimensions[0]?.field ?? "");
  return { xKey, metricKey };
}

export function WidgetChart({
  query,
  result,
  chartType,
  height = 240,
}: {
  query: AnalyticsQuery;
  result: QueryResult;
  chartType: ChartType;
  height?: number;
}) {
  const { xKey, metricKey } = chartKeys(query);
  const rows = result.rows;
  const config = { [metricKey]: { label: metricKey, color: "var(--chart-1)" } } satisfies ChartConfig;
  const color = `var(--color-${metricKey})`;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        No data for this query.
      </div>
    );
  }

  if (chartType === "big_number") {
    const total = rows.reduce((a, r) => a + (typeof r[metricKey] === "number" ? (r[metricKey] as number) : 0), 0);
    return (
      <div className="flex flex-col items-center justify-center gap-1" style={{ height }}>
        <div className="text-4xl font-semibold tabular-nums">{fmtNum(total)}</div>
        <div className="text-xs text-muted-foreground">{metricKey}</div>
      </div>
    );
  }

  if (chartType === "table") {
    const cols = Object.keys(rows[0] ?? {});
    return (
      <div className="overflow-auto" style={{ maxHeight: height }}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-left text-xs text-muted-foreground">
              {cols.map((c) => (
                <th key={c} className="px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b last:border-b-0">
                {cols.map((c) => (
                  <td key={c} className="px-2 py-1 tabular-nums">
                    {fmtNum(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chartType === "pie") {
    return (
      <ChartContainer config={config} className="mx-auto aspect-square" style={{ height }}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Pie data={rows} dataKey={metricKey} nameKey={xKey} innerRadius={height / 5}>
            {rows.map((r, i) => (
              <Cell key={String(r[xKey] ?? i)} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    );
  }

  if (chartType === "line") {
    return (
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
        <LineChart data={rows} margin={{ left: 12, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={44} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Line dataKey={metricKey} type="monotone" stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ChartContainer>
    );
  }

  // bar (time series) + horizontal_bar. Recharts layout="vertical" renders horizontal bars.
  const horizontal = chartType === "horizontal_bar";
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={rows} layout={horizontal ? "vertical" : "horizontal"} margin={{ left: 8, right: 16, top: 8 }}>
        <CartesianGrid horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} hide />
            <YAxis type="category" dataKey={xKey} tickLine={false} axisLine={false} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={44} />
          </>
        )}
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey={metricKey} fill={color} radius={2} />
      </BarChart>
    </ChartContainer>
  );
}
