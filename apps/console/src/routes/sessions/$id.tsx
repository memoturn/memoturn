import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity, Coins, DollarSign, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "../../components/empty-state";
import { JsonValue } from "../../components/json-value";
import { PageHeader } from "../../components/page-header";
import { ScoreBadges } from "../../components/score-badges";
import { StatTile } from "../../components/stat-tile";
import { TracePeekDrawer } from "../../components/trace-peek-drawer";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { api } from "../../lib/api";

interface SessionSearch {
  peek?: string;
}

/** One chat message extracted from a turn's payload. */
interface TurnMessage {
  role: string;
  content: string;
}

/** Parse a payload into role-attributed chat messages: a message array, a single {role,content}
 *  object, or null when it isn't chat-shaped (the caller falls back to the raw box). */
function parseTurnMessages(raw: string): TurnMessage[] | null {
  try {
    const v = JSON.parse(raw) as unknown;
    const toMsg = (m: unknown): TurnMessage | null => {
      if (!m || typeof m !== "object" || !("role" in m)) return null;
      const rec = m as { role: unknown; content?: unknown };
      return {
        role: String(rec.role),
        content: typeof rec.content === "string" ? rec.content : JSON.stringify(rec.content ?? "", null, 2),
      };
    };
    if (Array.isArray(v)) {
      const msgs = v.map(toMsg);
      return msgs.every((m): m is TurnMessage => m !== null) && msgs.length > 0 ? msgs : null;
    }
    const single = toMsg(v);
    return single ? [single] : null;
  } catch {
    return null;
  }
}

/** Role-styled chat bubble; long system prompts start collapsed. */
function RoleBubble({ role, content }: TurnMessage) {
  const tone =
    role === "assistant"
      ? "border-primary/20 bg-primary/5"
      : role === "system"
        ? "border-border bg-muted/40"
        : role === "tool"
          ? "border-amber-500/30 bg-amber-500/5"
          : "bg-muted/60";
  const body = <div className="text-sm whitespace-pre-wrap">{content}</div>;
  return (
    <div className={`rounded-md border p-2 ${tone}`}>
      <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{role}</div>
      {role === "system" && content.length > 280 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {content.slice(0, 160)}… <span className="underline">expand system prompt</span>
          </summary>
          {body}
        </details>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * The Memory Explorer conversation view: each trace is a turn, oldest-first, rendered as
 * role-attributed chat bubbles when the payload is chat-shaped (raw input/output boxes
 * otherwise). The JSON toggle switches to the raw payloads.
 */
function Conversation({
  sessionId,
  onPeek,
  scores,
}: {
  sessionId: string;
  onPeek: (id: string) => void;
  scores: Record<string, { name: string; value: number | null; string_value: string }[]>;
}) {
  const [rawJson, setRawJson] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["session-messages", sessionId],
    queryFn: () => api.getSessionMessages(sessionId),
  });
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <EmptyState title="Failed to load conversation" description={String(error)} />;
  const messages = data?.messages ?? [];
  if (messages.length === 0)
    return <EmptyState icon={MessagesSquare} title="No messages" description="This session has no trace I/O yet." />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          <Button
            variant={rawJson ? "ghost" : "secondary"}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setRawJson(false)}
          >
            Formatted
          </Button>
          <Button
            variant={rawJson ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setRawJson(true)}
          >
            JSON
          </Button>
        </div>
      </div>
      {messages.map((m) => {
        const inMsgs = rawJson ? null : parseTurnMessages(m.input);
        const outMsgs = rawJson ? null : parseTurnMessages(m.output);
        // The last input message usually repeats as the model's user turn — render the input
        // conversation once, then the output as the assistant's reply.
        return (
          <div key={m.traceId} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-foreground">{m.name || "(unnamed turn)"}</span>
                <ScoreBadges scores={scores[m.traceId] ?? []} />
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Timestamp value={m.timestamp} />
                <button type="button" onClick={() => onPeek(m.traceId)} className="text-primary hover:underline">
                  View trace →
                </button>
              </span>
            </div>
            {m.input &&
              (inMsgs ? (
                inMsgs.map((msg, i) => <RoleBubble key={`${m.traceId}-in-${i}-${msg.role}`} {...msg} />)
              ) : (
                <div className="rounded-md bg-muted/60 p-2">
                  <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Input
                  </div>
                  <JsonValue value={m.input} maxHeight="max-h-40" />
                </div>
              ))}
            {m.output &&
              (outMsgs ? (
                outMsgs.map((msg, i) => <RoleBubble key={`${m.traceId}-out-${i}-${msg.role}`} {...msg} />)
              ) : (
                <div className="rounded-md border border-primary/20 bg-primary/5 p-2">
                  <div className="mb-1 text-[10px] font-semibold tracking-wide text-primary uppercase">Output</div>
                  <JsonValue value={m.output} maxHeight="max-h-40" />
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

export const Route = createFileRoute("/sessions/$id")({
  validateSearch: (s: Record<string, unknown>): SessionSearch => ({
    peek: typeof s.peek === "string" && s.peek ? s.peek : undefined,
  }),
  component: SessionDetailPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function SessionDetailPage() {
  const { id } = Route.useParams();
  const { peek } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setPeek = (pid: string | undefined) => navigate({ search: (prev) => ({ ...prev, peek: pid }) });
  const [tab, setTab] = useState("conversation");

  const { data, isLoading, error } = useQuery({
    queryKey: ["session-traces", id],
    queryFn: () => api.listTracesPage({ sessionId: id, pageSize: 500 }),
  });
  const traces = data?.data;
  const scores = data?.scores ?? {};

  // Show the session as a conversation — oldest trace first (the list query returns newest-first).
  const ordered = traces ? [...traces].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : undefined;
  const totalTokens = ordered?.reduce((a, t) => a + Number(t.total_tokens), 0) ?? 0;
  const totalCost = ordered?.reduce((a, t) => a + Number(t.total_cost), 0) ?? 0;

  return (
    <div className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/sessions">Sessions</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[40ch] truncate">{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader
        title={`Session ${id}`}
        description="A conversation across the traces sharing this session id — click a turn to preview its trace."
        help="Conversation reconstructs each trace's input/output as a turn (oldest-first); Traces is the flat list."
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load traces" description={String(error)} />
      ) : !ordered || ordered.length === 0 ? (
        <EmptyState icon={Activity} title="No traces in this session" description="This session has no traces yet." />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Traces" value={ordered.length} icon={Activity} help="Number of traces in this session." />
            <StatTile
              label="Tokens"
              value={totalTokens}
              icon={Coins}
              help="Total input plus output tokens across this session's traces."
            />
            <StatTile
              label="Cost"
              value={fmtCost(totalCost)}
              icon={DollarSign}
              help="Estimated spend for this session, from the model price table."
            />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="traces">Traces ({ordered.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="conversation">
              <Conversation sessionId={id} onPeek={setPeek} scores={scores} />
            </TabsContent>

            <TabsContent value="traces">
              <div className="border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trace Name</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead>Trace ID</TableHead>
                      <TableHead>Timestamp</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Scores</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordered.map((t) => (
                      <TableRow
                        key={t.id}
                        data-state={peek === t.id ? "selected" : undefined}
                        onClick={() => setPeek(t.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setPeek(t.id);
                        }}
                        tabIndex={0}
                        className="cursor-pointer"
                      >
                        <TableCell>
                          <span className="font-medium text-primary">{t.name || "(unnamed trace)"}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {t.session_path || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{t.id}</TableCell>
                        <TableCell className="text-muted-foreground">
                          <Timestamp value={t.timestamp} />
                        </TableCell>
                        <TableCell className="tabular-nums">{Number(t.total_tokens).toLocaleString()}</TableCell>
                        <TableCell className="tabular-nums">{fmtCost(Number(t.total_cost))}</TableCell>
                        <TableCell className="tabular-nums">{t.latency_ms} ms</TableCell>
                        <TableCell>
                          <ScoreBadges scores={scores[t.id] ?? []} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <TracePeekDrawer traces={ordered} peekId={peek} onPeek={setPeek} />
    </div>
  );
}
