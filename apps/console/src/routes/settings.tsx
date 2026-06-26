import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../lib/api";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const { data: providers } = useQuery({ queryKey: ["providers"], queryFn: () => api.listProviders() });

  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");

  const save = useMutation({
    mutationFn: () => api.addProvider(provider, apiKey),
    onSuccess: () => {
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });

  const { data: retention } = useQuery({ queryKey: ["retention"], queryFn: () => api.getRetention() });
  const [days, setDays] = useState<number | null>(null);
  const saveRetention = useMutation({
    mutationFn: () => api.setRetention(days ?? 0),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["retention"] }),
  });
  const daysValue = days ?? retention?.days ?? 0;

  const { data: webhooks } = useQuery({ queryKey: ["webhooks"], queryFn: () => api.listWebhooks() });
  const [url, setUrl] = useState("");
  const [threshold, setThreshold] = useState("");
  const addWebhook = useMutation({
    mutationFn: () =>
      api.createWebhook({ url, event: "score.created", threshold: threshold === "" ? null : Number(threshold) }),
    onSuccess: () => {
      setUrl("");
      setThreshold("");
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
  const removeWebhook = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
  });

  const { data: scoreConfigs } = useQuery({ queryKey: ["score-configs"], queryFn: () => api.listScoreConfigs() });
  const [scName, setScName] = useState("");
  const [scType, setScType] = useState("NUMERIC");
  const [scCategories, setScCategories] = useState("");
  const addScoreConfig = useMutation({
    mutationFn: () =>
      api.createScoreConfig({
        name: scName,
        dataType: scType,
        categories:
          scType === "CATEGORICAL"
            ? scCategories
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      }),
    onSuccess: () => {
      setScName("");
      setScCategories("");
      qc.invalidateQueries({ queryKey: ["score-configs"] });
    },
  });
  const removeScoreConfig = useMutation({
    mutationFn: (id: string) => api.deleteScoreConfig(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["score-configs"] }),
  });

  const { data: modelPrices } = useQuery({ queryKey: ["model-prices"], queryFn: () => api.listModelPrices() });
  const [mpPattern, setMpPattern] = useState("");
  const [mpProvider, setMpProvider] = useState("");
  const [mpInput, setMpInput] = useState("");
  const [mpOutput, setMpOutput] = useState("");
  const addModelPrice = useMutation({
    mutationFn: () =>
      api.createModelPrice({
        pattern: mpPattern,
        provider: mpProvider || undefined,
        inputPerMTok: Number(mpInput),
        outputPerMTok: Number(mpOutput),
      }),
    onSuccess: () => {
      setMpPattern("");
      setMpProvider("");
      setMpInput("");
      setMpOutput("");
      qc.invalidateQueries({ queryKey: ["model-prices"] });
    },
  });
  const removeModelPrice = useMutation({
    mutationFn: (id: string) => api.deleteModelPrice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["model-prices"] }),
  });

  return (
    <div>
      <h1>Settings</h1>

      <h2>LLM provider connections</h2>
      <p className="obs-meta">
        API keys are encrypted at rest and used by the playground + evaluators. The "mock" provider needs no key.
      </p>
      <div className="filters">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
        </select>
        <input
          type="password"
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ width: 260 }}
        />
        <button disabled={!apiKey || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save key"}
        </button>
      </div>

      {!providers || providers.length === 0 ? (
        <div className="empty">No provider keys configured.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Key</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.provider}>
                <td>{p.provider}</td>
                <td>{p.masked}</td>
                <td>{p.createdAt.slice(0, 19).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Data retention</h2>
      <p className="obs-meta">
        Delete traces/observations/scores older than N days (0 = keep forever). A daily worker job enforces this.
      </p>
      <div className="filters">
        <input
          type="number"
          min="0"
          value={daysValue}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <span className="obs-meta" style={{ alignSelf: "center" }}>
          days
        </span>
        <button disabled={saveRetention.isPending} onClick={() => saveRetention.mutate()}>
          {saveRetention.isPending ? "Saving…" : "Save retention"}
        </button>
      </div>

      <h2>Webhooks</h2>
      <p className="obs-meta">
        POST to a URL when a score is created. Set a threshold to only fire on low scores (value &lt; threshold).
      </p>
      <div className="filters">
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 320 }} />
        <input
          type="number"
          step="0.1"
          placeholder="threshold (optional)"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          style={{ width: 160 }}
        />
        <button disabled={!url || addWebhook.isPending} onClick={() => addWebhook.mutate()}>
          {addWebhook.isPending ? "Saving…" : "Add webhook"}
        </button>
      </div>
      {webhooks && webhooks.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Event</th>
              <th>Threshold</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {webhooks.map((w) => (
              <tr key={w.id}>
                <td>{w.url}</td>
                <td>
                  <span className="badge gen">{w.event}</span>
                </td>
                <td>{w.threshold ?? "—"}</td>
                <td>
                  <button className="link-btn" onClick={() => removeWebhook.mutate(w.id)}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Score configs</h2>
      <p className="obs-meta">
        Define the scores used for this project. Categorical configs drive the review form (dropdown of categories).
      </p>
      <div className="filters">
        <input placeholder="score name" value={scName} onChange={(e) => setScName(e.target.value)} />
        <select value={scType} onChange={(e) => setScType(e.target.value)}>
          <option value="NUMERIC">numeric</option>
          <option value="CATEGORICAL">categorical</option>
          <option value="BOOLEAN">boolean</option>
        </select>
        {scType === "CATEGORICAL" && (
          <input
            placeholder="categories (comma-separated)"
            value={scCategories}
            onChange={(e) => setScCategories(e.target.value)}
            style={{ width: 240 }}
          />
        )}
        <button disabled={!scName || addScoreConfig.isPending} onClick={() => addScoreConfig.mutate()}>
          {addScoreConfig.isPending ? "Saving…" : "Add score"}
        </button>
      </div>
      {scoreConfigs && scoreConfigs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Categories</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {scoreConfigs.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>
                  <span className="badge">{s.dataType.toLowerCase()}</span>
                </td>
                <td className="obs-meta">{s.categories.join(", ") || "—"}</td>
                <td>
                  <button className="link-btn" onClick={() => removeScoreConfig.mutate(s.id)}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Model pricing</h2>
      <p className="obs-meta">
        Override token prices (USD per 1M tokens) for models matched by a name pattern (a case-insensitive regex, e.g.{" "}
        <code>^my-model</code>). Overrides take precedence over the built-in defaults and apply to newly ingested
        generations.
      </p>
      <div className="filters">
        <input
          placeholder="pattern (e.g. ^my-model)"
          value={mpPattern}
          onChange={(e) => setMpPattern(e.target.value)}
        />
        <input placeholder="provider (optional)" value={mpProvider} onChange={(e) => setMpProvider(e.target.value)} />
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="input / 1M"
          value={mpInput}
          onChange={(e) => setMpInput(e.target.value)}
          style={{ width: 110 }}
        />
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="output / 1M"
          value={mpOutput}
          onChange={(e) => setMpOutput(e.target.value)}
          style={{ width: 110 }}
        />
        <button
          disabled={!mpPattern || mpInput === "" || mpOutput === "" || addModelPrice.isPending}
          onClick={() => addModelPrice.mutate()}
        >
          {addModelPrice.isPending ? "Saving…" : "Add price"}
        </button>
      </div>
      {modelPrices && modelPrices.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Provider</th>
              <th>Input / 1M</th>
              <th>Output / 1M</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {modelPrices.data.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.pattern}</code>
                </td>
                <td>{p.provider || "—"}</td>
                <td>${p.inputPerMTok}</td>
                <td>${p.outputPerMTok}</td>
                <td>
                  <button className="link-btn" onClick={() => removeModelPrice.mutate(p.id)}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modelPrices && modelPrices.builtins.length > 0 && (
        <details>
          <summary className="obs-meta">Built-in defaults ({modelPrices.builtins.length})</summary>
          <table>
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Provider</th>
                <th>Input / 1M</th>
                <th>Output / 1M</th>
              </tr>
            </thead>
            <tbody>
              {modelPrices.builtins.map((p) => (
                <tr key={p.pattern}>
                  <td>
                    <code>{p.pattern}</code>
                  </td>
                  <td>{p.provider}</td>
                  <td>${p.inputPerMTok}</td>
                  <td>${p.outputPerMTok}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
