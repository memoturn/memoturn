import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, type PlaygroundResponse } from "../lib/api";

export const Route = createFileRoute("/playground")({ component: PlaygroundPage });

function PlaygroundPage() {
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [system, setSystem] = useState("You are a helpful assistant.");
  const [userMsg, setUserMsg] = useState("Explain what memoturn is in one sentence.");
  const [temperature, setTemperature] = useState(0.2);
  const [result, setResult] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sensible default model per provider.
  function onProvider(p: string) {
    setProvider(p);
    setModel(p === "anthropic" ? "claude-sonnet-4-6" : p === "openai" ? "gpt-4o-mini" : "mock-1");
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.playgroundChat({
        provider,
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Playground</h1>
      <div className="filters">
        <select value={provider} onChange={(e) => onProvider(e.target.value)}>
          <option value="mock">mock</option>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
        </select>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          style={{ width: 90 }}
        />
        <button onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      <h2>System</h2>
      <textarea className="pg-input" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} />
      <h2>User</h2>
      <textarea className="pg-input" value={userMsg} onChange={(e) => setUserMsg(e.target.value)} rows={4} />

      {error && <div className="empty" style={{ marginTop: 16 }}>{error}</div>}
      {result && (
        <>
          <h2>Response</h2>
          <pre>{result.content}</pre>
          <div className="obs-meta">
            {result.provider}/{result.model} · {result.usage.totalTokens} tokens (
            {result.usage.promptTokens}+{result.usage.completionTokens})
          </div>
        </>
      )}
    </div>
  );
}
