import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../lib/api";

export const Route = createFileRoute("/evaluators")({ component: EvaluatorsPage });

function EvaluatorsPage() {
  const qc = useQueryClient();
  const { data: evaluators } = useQuery({ queryKey: ["evaluators"], queryFn: () => api.listEvaluators() });

  const [name, setName] = useState("");
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [prompt, setPrompt] = useState("Score how well the output answers the input. 1 = perfect, 0 = wrong.");
  const [online, setOnline] = useState(false);
  const [samplingRate, setSamplingRate] = useState(1);

  const create = useMutation({
    mutationFn: () => api.createEvaluator({ name, prompt, provider, model, online, samplingRate }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["evaluators"] });
    },
  });

  return (
    <div>
      <h1>Evaluators</h1>
      <p className="obs-meta">LLM-as-judge evaluators. Run them over a trace's input/output to record an EVAL score.</p>

      <h2>New evaluator</h2>
      <div className="filters">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="mock">mock</option>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
        </select>
        <input placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
        <label className="inline-check">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> online
        </label>
        {online && (
          <input
            type="number"
            step="0.1"
            min="0"
            max="1"
            value={samplingRate}
            onChange={(e) => setSamplingRate(Number(e.target.value))}
            title="sampling rate"
            style={{ width: 80 }}
          />
        )}
        <button disabled={!name || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Saving…" : "Create"}
        </button>
      </div>
      <textarea className="pg-input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <h2>Evaluators ({evaluators?.length ?? 0})</h2>
      {!evaluators || evaluators.length === 0 ? (
        <div className="empty">No evaluators yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Online</th>
              <th>Prompt</th>
            </tr>
          </thead>
          <tbody>
            {evaluators.map((e) => (
              <tr key={e.name}>
                <td>{e.name}</td>
                <td>
                  <span className="badge gen">{e.provider}</span>
                </td>
                <td>{e.model}</td>
                <td>{e.online ? <span className="badge span">{Math.round(e.samplingRate * 100)}%</span> : "—"}</td>
                <td className="obs-meta">{e.prompt.slice(0, 70)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
