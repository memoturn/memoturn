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

  return (
    <div>
      <h1>Settings</h1>

      <h2>LLM provider connections</h2>
      <p className="obs-meta">API keys are encrypted at rest and used by the playground + evaluators. The "mock" provider needs no key.</p>
      <div className="filters">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
        </select>
        <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: 260 }} />
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
    </div>
  );
}
