import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api, type DailyMetric } from "../lib/api";

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });

function money(n: number): string {
  return `$${Number(n).toFixed(4)}`;
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return <span className="bar" style={{ width: `${pct}%` }} />;
}

function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.getMetrics(30),
    refetchInterval: 10_000,
  });

  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="empty">Failed to load: {String(error)}</div>;
  if (!data) return null;

  const maxCost = Math.max(0, ...data.byDay.map((d) => d.total_cost));

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="stats">
        <Stat label="Traces" value={data.total_traces.toLocaleString()} />
        <Stat label="Generations" value={data.total_generations.toLocaleString()} />
        <Stat label="Tokens" value={data.total_tokens.toLocaleString()} />
        <Stat label="Cost" value={money(data.total_cost)} />
      </div>

      <h2>Cost by day (30d)</h2>
      {data.byDay.length === 0 ? (
        <div className="empty">No generation data yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Gens</th>
              <th>Tokens</th>
              <th>p95 latency</th>
              <th style={{ width: "40%" }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.byDay.map((d: DailyMetric) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{d.generations}</td>
                <td>{d.total_tokens.toLocaleString()}</td>
                <td>{d.p95_latency_ms} ms</td>
                <td>
                  <div className="barrow">
                    <Bar value={d.total_cost} max={maxCost} />
                    <span>{money(d.total_cost)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>By model</h2>
      {data.byModel.length === 0 ? (
        <div className="empty">No model data yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Gens</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.generations}</td>
                <td>{m.total_tokens.toLocaleString()}</td>
                <td>{money(m.total_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
