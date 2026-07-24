import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity, Coins, DollarSign, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../../components/empty-state";
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
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { api } from "../../lib/api";

interface SessionSearch {
  peek?: string;
}

/** Best-effort pretty-print: JSON gets indented, everything else passes through. */
function prettyText(raw: string): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** The Memory Explorer conversation view: each trace is a turn (input → output), oldest-first. */
function Conversation({ sessionId, onPeek }: { sessionId: string; onPeek: (id: string) => void }) {
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
      {messages.map((m) => (
        <button
          type="button"
          key={m.traceId}
          onClick={() => onPeek(m.traceId)}
          className="block w-full space-y-2 rounded-lg border p-3 text-left hover:border-primary/50"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{m.name || "(unnamed turn)"}</span>
            <span>{m.timestamp}</span>
          </div>
          {m.input && (
            <div className="rounded-md bg-muted/60 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Input</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                {prettyText(m.input)}
              </pre>
            </div>
          )}
          {m.output && (
            <div className="rounded-md border border-primary/20 bg-primary/5 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">Output</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                {prettyText(m.output)}
              </pre>
            </div>
          )}
        </button>
      ))}
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
          <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
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
              <Conversation sessionId={id} onPeek={setPeek} />
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
                        <TableCell className="text-muted-foreground">{t.timestamp}</TableCell>
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
