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

  const create = useMutation({
    mutationFn: () => api.createEvaluator({ name, prompt, provider, model }),
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
                <td className="obs-meta">{e.prompt.slice(0, 80)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
