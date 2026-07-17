import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import { api, getActiveProject } from "../lib/api";
import { useRangeDays } from "../lib/timeRange";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";

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

/**
 * Chat state + the context (org, project, current page, time range) sent with every ask so the
 * assistant knows where the user is. Context is read at send time, so a conversation kept open
 * across navigation always reflects the page the user is actually looking at.
 */
export function useAssistantChat() {
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [messages, setMessages] = useState<Msg[]>([]);
  const location = useLocation();
  const rangeDays = useRangeDays();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const activeProject = (projects ?? []).find((p) => p.id === getActiveProject());

  const context = {
    organization: activeProject?.organization,
    project: activeProject?.name,
    page: location.pathname,
    rangeDays,
  };

  const ask = useMutation({
    mutationFn: ({ history, ctx }: { history: Msg[]; ctx: typeof context }) =>
      api.assistantChat({
        provider,
        model,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        context: ctx,
      }),
    onSuccess: (res) => setMessages((prev) => [...prev, { role: "assistant", content: res.content, steps: res.steps }]),
    onError: (e) => setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]),
  });

  const send = (text: string) => {
    const q = text.trim();
    if (!q || ask.isPending) return;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    ask.mutate({ history: next, ctx: context });
  };

  const onProvider = (p: string) => {
    setProvider(p);
    setModel(defaultModel(p));
  };

  return { provider, onProvider, model, setModel, messages, send, pending: ask.isPending, context };
}

export function AssistantChat({ chat }: { chat: ReturnType<typeof useAssistantChat> }) {
  const [input, setInput] = useState("");
  const submit = (text: string) => {
    chat.send(text);
    setInput("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select value={chat.provider} onValueChange={chat.onProvider}>
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
        <Input value={chat.model} onChange={(e) => chat.setModel(e.target.value)} className="h-8 w-40 text-xs" />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border bg-muted/20 p-4">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <Sparkles className="size-6 opacity-60" />
            <p>Ask about traces, cost, latency, errors, or scores in this project.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-7 text-xs" onClick={() => submit(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((m, i) => (
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
        {chat.pending && <div className="text-sm text-muted-foreground">Thinking…</div>}
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your telemetry…"
          disabled={chat.pending}
        />
        <Button type="submit" disabled={chat.pending || !input.trim()} className="gap-1.5">
          <Send className="size-4" />
          Send
        </Button>
      </form>
    </div>
  );
}

/**
 * The topbar "Ask AI" entry: a right-side drawer over the current page. Chat state lives here
 * (outside SheetContent), so the conversation survives closing the drawer and navigating.
 */
export function AssistantDrawer() {
  const chat = useAssistantChat();
  const where = [chat.context.project, chat.context.organization].filter(Boolean).join(" · ");

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" aria-label="Ask AI">
          <Sparkles className="text-primary" />
          <span className="hidden sm:inline">Ask AI</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="gap-0 data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" />
            Ask AI
          </SheetTitle>
          <SheetDescription className="text-xs">
            Read-only copilot over {where || "this project"}'s telemetry — sees the page you're on and the selected time
            range.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <AssistantChat chat={chat} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
