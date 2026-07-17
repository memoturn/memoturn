import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { api } from "../lib/api";

export const Route = createFileRoute("/assistant")({ component: AssistantPage });

type Step = { tool: string; args: unknown; result: unknown };
type Msg = { role: "user" | "assistant"; content: string; steps?: Step[] };

const PROVIDERS = ["mock", "anthropic", "openai", "gemini"];
const defaultModel = (p: string) =>
  p === "anthropic" ? "claude-sonnet-5" : p === "openai" ? "gpt-4o-mini" : p === "gemini" ? "gemini-2.5-pro" : "mock-1";

const SUGGESTIONS = [
  "What are the slowest traces in the last day?",
  "Summarize today's errors.",
  "Which model costs the most?",
];

function ToolSteps({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {steps.length} tool call{steps.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l pl-2">
          {steps.map((s, i) => (
            <div key={`${s.tool}-${i}`} className="font-mono text-[0.6875rem] text-muted-foreground">
              <span className="text-foreground">{s.tool}</span>({JSON.stringify(s.args)})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantPage() {
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");

  const ask = useMutation({
    mutationFn: (history: Msg[]) =>
      api.assistantChat({ provider, model, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
    onSuccess: (res) => setMessages((prev) => [...prev, { role: "assistant", content: res.content, steps: res.steps }]),
    onError: (e) => setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]),
  });

  const send = (text: string) => {
    const q = text.trim();
    if (!q || ask.isPending) return;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    ask.mutate(next);
  };

  const onProvider = (p: string) => {
    setProvider(p);
    setModel(defaultModel(p));
  };

  return (
    <div className="flex h-[calc(100svh-6rem)] flex-col gap-4">
      <PageHeader
        title="Assistant"
        description="Ask about your project's telemetry — the assistant queries your traces, metrics, and scores (read-only) to answer."
        help="A copilot that runs an agentic loop over memoturn's own read-only tools (traces, metrics, scores, prompts, datasets), scoped to this project."
        actions={
          <div className="flex items-center gap-2">
            <Select value={provider} onValueChange={onProvider}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="h-8 w-40 text-xs" />
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border bg-muted/20 p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <Sparkles className="size-6 opacity-60" />
            <p>Ask about traces, cost, latency, errors, or scores in this project.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-7 text-xs" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-background"
                }`}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.role === "assistant" && m.steps && <ToolSteps steps={m.steps} />}
              </div>
            </div>
          ))
        )}
        {ask.isPending && <div className="text-sm text-muted-foreground">Thinking…</div>}
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your telemetry…"
          disabled={ask.isPending}
        />
        <Button type="submit" disabled={ask.isPending || !input.trim()} className="gap-1.5">
          <Send className="size-4" />
          Send
        </Button>
      </form>
    </div>
  );
}
