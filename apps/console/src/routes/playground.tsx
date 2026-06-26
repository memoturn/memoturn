import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type PlaygroundResponse, streamPlayground } from "../lib/api";

export const Route = createFileRoute("/playground")({ component: PlaygroundPage });

function PlaygroundPage() {
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [system, setSystem] = useState("You are a helpful assistant.");
  const [userMsg, setUserMsg] = useState("Explain what memoturn is in one sentence.");
  const [temperature, setTemperature] = useState(0.2);
  const [mode, setMode] = useState<"chat" | "structured" | "tools">("chat");
  const [schemaText, setSchemaText] = useState(
    JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, null, 2),
  );
  const [toolsText, setToolsText] = useState(
    JSON.stringify(
      [
        {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      null,
      2,
    ),
  );
  const [streaming, setStreaming] = useState(true);
  const [streamed, setStreamed] = useState("");
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
    setStreamed("");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: userMsg },
    ];
    try {
      const responseFormat =
        mode === "structured" ? { type: "json_schema" as const, schema: JSON.parse(schemaText) } : undefined;
      const tools = mode === "tools" ? JSON.parse(toolsText) : undefined;
      // Tools + structured output only run through the non-streaming path.
      if (mode === "chat" && streaming) {
        await streamPlayground({ provider, model, temperature, messages }, (delta) =>
          setStreamed((prev) => prev + delta),
        );
      } else {
        setResult(await api.playgroundChat({ provider, model, temperature, messages, tools, responseFormat }));
      }
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
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} title="Output mode">
          <option value="chat">chat</option>
          <option value="structured">structured output</option>
          <option value="tools">tools</option>
        </select>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={streaming}
            disabled={mode !== "chat"}
            onChange={(e) => setStreaming(e.target.checked)}
          />{" "}
          stream
        </label>
        <button onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      <h2>System</h2>
      <textarea className="pg-input" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} />
      <h2>User</h2>
      <textarea className="pg-input" value={userMsg} onChange={(e) => setUserMsg(e.target.value)} rows={4} />

      {mode === "structured" && (
        <>
          <h2>JSON schema</h2>
          <textarea className="pg-input" value={schemaText} onChange={(e) => setSchemaText(e.target.value)} rows={8} />
        </>
      )}
      {mode === "tools" && (
        <>
          <h2>Tools (JSON)</h2>
          <textarea className="pg-input" value={toolsText} onChange={(e) => setToolsText(e.target.value)} rows={10} />
        </>
      )}

      {error && (
        <div className="empty" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}
      {streamed && (
        <>
          <h2>Response (streaming)</h2>
          <pre>{streamed}</pre>
        </>
      )}
      {result && (
        <>
          <h2>Response</h2>
          <pre>{result.content}</pre>
          <div className="obs-meta">
            {result.provider}/{result.model} · {result.usage.totalTokens} tokens ({result.usage.promptTokens}+
            {result.usage.completionTokens})
            {result.traceId && (
              <>
                {" · "}
                <Link to="/traces/$id" params={{ id: result.traceId }}>
                  view trace →
                </Link>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
