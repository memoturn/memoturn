import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { api, getActiveProject, streamAssistant } from "../lib/api";
import { useRangeDays } from "../lib/timeRange";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "./ai-elements/message";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "./ai-elements/prompt-input";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "./ai-elements/tool";
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

  const [pending, setPending] = useState(false);

  // Mutate the trailing assistant message in place as stream events arrive.
  const patchLast = (patch: (last: Msg) => Msg) =>
    setMessages((prev) => [...prev.slice(0, -1), patch(prev[prev.length - 1] as Msg)]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const history: Msg[] = [...messages, { role: "user", content: q }];
    setMessages([...history, { role: "assistant", content: "", steps: [] }]);
    setPending(true);
    try {
      await streamAssistant(
        {
          provider,
          model,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          context,
        },
        {
          onDelta: (delta) => patchLast((last) => ({ ...last, content: last.content + delta })),
          onStep: (step) => patchLast((last) => ({ ...last, steps: [...(last.steps ?? []), step] })),
        },
      );
    } catch (e) {
      patchLast((last) => ({ ...last, content: `${last.content}\n\nError: ${String(e)}`.trim() }));
    } finally {
      setPending(false);
    }
  };

  const onProvider = (p: string) => {
    setProvider(p);
    setModel(defaultModel(p));
  };

  return { provider, onProvider, model, setModel, messages, send, pending, context };
}

function AssistantSteps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((s, i) => {
        const errored = typeof s.result === "object" && s.result !== null && "error" in s.result;
        return (
          <Tool key={`${s.tool}-${i}`}>
            <ToolHeader state={errored ? "output-error" : "output-available"} title={s.tool} />
            <ToolContent>
              <ToolInput input={s.args} />
              <ToolOutput output={s.result} />
            </ToolContent>
          </Tool>
        );
      })}
    </div>
  );
}

export function AssistantChat({ chat }: { chat: ReturnType<typeof useAssistantChat> }) {
  const [input, setInput] = useState("");
  const submit = (text: string) => {
    chat.send(text);
    setInput("");
  };
  // Shimmer only until the first stream event lands; after that the growing message is the feedback.
  const last = chat.messages[chat.messages.length - 1];
  const thinking = chat.pending && last?.role === "assistant" && !last.content && !last.steps?.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Conversation className="rounded-lg border bg-muted/20">
        <ConversationContent className={chat.messages.length === 0 ? "h-full" : undefined}>
          {chat.messages.length === 0 ? (
            <ConversationEmptyState icon={<Sparkles className="size-6 opacity-60" />}>
              <Sparkles className="size-6 text-muted-foreground opacity-60" />
              <div className="space-y-1">
                <h3 className="text-sm font-medium">How can I help?</h3>
                <p className="text-sm text-muted-foreground">
                  Ask about traces, cost, latency, errors, or scores in this project.
                </p>
              </div>
              <Suggestions className="justify-center">
                {SUGGESTIONS.map((s) => (
                  <Suggestion key={s} onClick={submit} suggestion={s} />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : (
            <>
              {chat.messages.map((m, i) => (
                <Message from={m.role} key={`${m.role}-${i}`}>
                  <MessageContent>
                    {m.role === "assistant" ? (
                      <>
                        {m.steps && <AssistantSteps steps={m.steps} />}
                        <MessageResponse>{m.content}</MessageResponse>
                      </>
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </MessageContent>
                </Message>
              ))}
              {thinking && <p className="text-shimmer w-fit text-sm">Thinking…</p>}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput onSubmit={() => submit(input)}>
        <PromptInputTextarea disabled={chat.pending} onChange={(e) => setInput(e.target.value)} value={input} />
        <PromptInputToolbar>
          <PromptInputTools>
            <Select onValueChange={chat.onProvider} value={chat.provider}>
              <SelectTrigger aria-label="Provider" className="h-7 w-28 border-none bg-transparent text-xs shadow-none">
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
            <Input
              aria-label="Model"
              className="h-7 w-36 border-none bg-transparent text-xs shadow-none"
              onChange={(e) => chat.setModel(e.target.value)}
              value={chat.model}
            />
          </PromptInputTools>
          <PromptInputSubmit disabled={chat.pending || !input.trim()} pending={chat.pending} />
        </PromptInputToolbar>
      </PromptInput>
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
