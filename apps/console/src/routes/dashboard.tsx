import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, type DailyMetric, type Widget } from "../lib/api";

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

      <CustomWidgets />
    </div>
  );
}

function CustomWidgets() {
  const qc = useQueryClient();
  const { data: widgets } = useQuery({ queryKey: ["widgets"], queryFn: () => api.listWidgets() });
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState("cost");
  const [breakdown, setBreakdown] = useState("by_day");

  const add = useMutation({
    mutationFn: () => api.createWidget({ title, metric, breakdown, days: 30 }),
    onSuccess: () => {
      setTitle("");
      qc.invalidateQueries({ queryKey: ["widgets"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWidget(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["widgets"] }),
  });

  return (
    <>
      <h2>Custom widgets</h2>
      <div className="filters">
        <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={metric} onChange={(e) => setMetric(e.target.value)}>
          <option value="cost">cost</option>
          <option value="tokens">tokens</option>
          <option value="generations">generations</option>
          <option value="latency_p95">p95 latency</option>
        </select>
        <select value={breakdown} onChange={(e) => setBreakdown(e.target.value)}>
          <option value="by_day">by day</option>
          <option value="by_model">by model</option>
        </select>
        <button disabled={!title || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Adding…" : "Add widget"}
        </button>
      </div>

      {!widgets || widgets.length === 0 ? (
        <div className="empty">No custom widgets yet.</div>
      ) : (
        <div className="widget-grid">
          {widgets.map((w) => (
            <WidgetCard key={w.id} widget={w} onDelete={() => remove.mutate(w.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function WidgetCard({ widget, onDelete }: { widget: Widget; onDelete: () => void }) {
  const max = Math.max(0, ...widget.data.map((p) => p.value));
  const fmt = (v: number) => (widget.metric === "cost" ? `$${v.toFixed(4)}` : v.toLocaleString());
  return (
    <div className="widget">
      <div className="widget-head">
        <span className="obs-name">{widget.title}</span>
        <button className="link-btn" onClick={onDelete}>
          ✕
        </button>
      </div>
      <div className="obs-meta">
        {widget.metric} · {widget.breakdown.replace("_", " ")} · {widget.days}d
      </div>
      {widget.data.length === 0 ? (
        <div className="obs-meta">no data</div>
      ) : (
        widget.data.slice(-12).map((p) => (
          <div className="barrow" key={p.label}>
            <span className="widget-label">{p.label}</span>
            <Bar value={p.value} max={max} />
            <span>{fmt(p.value)}</span>
          </div>
        ))
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
