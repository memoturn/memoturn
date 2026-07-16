import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitBranch, Radio, Tag } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../../components/empty-state";
import { KindBadge } from "../../components/kind-badge";
import { StatTile } from "../../components/stat-tile";
import { TracePeekDrawer } from "../../components/trace-peek-drawer";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api, type PromptDetail, type PromptVersionDetail } from "../../lib/api";
import { diffLines } from "../../lib/diff";

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

/** Traces that logged a generation referencing this prompt (by prompt_id) — with the peek drawer. */
function PromptUsage({ name }: { name: string }) {
  const [peek, setPeek] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery({
    queryKey: ["prompt-traces", name],
    queryFn: () => api.listTracesPage({ promptId: name, pageSize: 25 }),
    refetchInterval: 10_000,
  });
  const traces = data?.data;
  const total = data?.total ?? 0;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Traces using this prompt{total > 0 ? ` (${total})` : ""}</CardTitle>
          <CardDescription>Traces with a generation that referenced this prompt's id.</CardDescription>
          {total > 25 && (
            <CardAction>
              <span className="text-xs text-muted-foreground">Showing 25 of {total.toLocaleString()}</span>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className={traces && traces.length > 0 ? "px-0" : undefined}>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !traces || traces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No traces yet. Traces appear here when a generation logs this prompt's id/version.
            </p>
          ) : (
            <div className="overflow-x-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trace Name</TableHead>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traces.map((t) => (
                    <TableRow
                      key={t.id}
                      data-state={peek === t.id ? "selected" : undefined}
                      onClick={() => setPeek(t.id)}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <span className="font-medium text-primary">{t.name || t.id.slice(0, 8)}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{t.timestamp}</TableCell>
                      <TableCell>{t.total_tokens}</TableCell>
                      <TableCell>{fmtCost(Number(t.total_cost))}</TableCell>
                      <TableCell>{t.latency_ms} ms</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <TracePeekDrawer traces={traces} peekId={peek} onPeek={setPeek} />
    </>
  );
}

export const Route = createFileRoute("/prompts/$name")({ component: PromptDetailPage });

function renderContent(v: PromptVersionDetail): string {
  if (v.type === "CHAT" && Array.isArray(v.content)) {
    return (v.content as { role: string; content: string }[]).map((m) => `[${m.role}] ${m.content}`).join("\n");
  }
  return String(v.content ?? "");
}

/** Full version text (messages + config) used as the diff input. */
function versionText(v: PromptVersionDetail): string {
  const config =
    v.config != null && Object.keys(v.config as object).length > 0
      ? `\n--- config ---\n${JSON.stringify(v.config, null, 2)}`
      : "";
  return renderContent(v) + config;
}

function VersionDiff({ prompt }: { prompt: PromptDetail }) {
  const versions = prompt.allVersions;
  const [a, setA] = useState<number>(versions[1]?.version ?? 0);
  const [b, setB] = useState<number>(versions[0]?.version ?? 0);
  const va = versions.find((v) => v.version === a);
  const vb = versions.find((v) => v.version === b);
  const rows = va && vb ? diffLines(versionText(va), versionText(vb)) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare versions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Select value={String(a)} onValueChange={(v) => setA(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  v{v.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">→</span>
          <Select value={String(b)} onValueChange={(v) => setB(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  v{v.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {a === b ? (
          <p className="text-sm text-muted-foreground">Select two different versions to see a diff.</p>
        ) : (
          <pre className="overflow-auto border bg-muted/30 p-3 text-xs max-h-96 leading-relaxed">
            {rows.map((r, idx) => (
              <div
                key={`${idx}-${r.type}`}
                className={
                  r.type === "add"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : r.type === "del"
                      ? "bg-red-500/15 text-red-700 dark:text-red-300"
                      : ""
                }
              >
                {r.type === "add" ? "+ " : r.type === "del" ? "- " : "  "}
                {r.text}
              </div>
            ))}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function PromptDetailPage() {
  const { name } = Route.useParams();
  const {
    data: prompt,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["prompt", name],
    queryFn: () => api.getPrompt(name),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <EmptyState title="Failed to load prompt" description={String(error)} />;
  if (!prompt) return <EmptyState title="Prompt not found" />;

  // Which channels point at each version.
  const channelsByVersion = new Map<number, string[]>();
  for (const c of prompt.channels) {
    channelsByVersion.set(c.version, [...(channelsByVersion.get(c.version) ?? []), c.label]);
  }

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/prompts">Prompts</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[40ch] truncate">{prompt.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{prompt.name}</h1>
        {prompt.folder && <p className="text-sm text-muted-foreground">{prompt.folder}</p>}
      </div>

      <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
        <StatTile label="Latest" value={`v${prompt.latestVersion}`} icon={Tag} />
        <StatTile label="Versions" value={prompt.allVersions.length} icon={GitBranch} />
        <StatTile label="Channels" value={prompt.channels.length} icon={Radio} />
      </div>

      {prompt.channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {prompt.channels.map((c) => (
                <KindBadge key={c.label} tone="blue">
                  {c.label} → v{c.version}
                </KindBadge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {prompt.allVersions.length > 1 && <VersionDiff prompt={prompt} />}

      <Card>
        <CardHeader>
          <CardTitle>Versions ({prompt.allVersions.length})</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Accordion type="multiple" className="border-t px-6">
            {prompt.allVersions.map((v) => (
              <AccordionItem key={v.version} value={`v${v.version}`}>
                <AccordionTrigger>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">v{v.version}</span>
                    <KindBadge tone="neutral">{v.type.toLowerCase()}</KindBadge>
                    {(channelsByVersion.get(v.version) ?? []).map((label) => (
                      <KindBadge key={label} tone="blue">
                        {label}
                      </KindBadge>
                    ))}
                    <span className="text-xs text-muted-foreground">{v.createdAt.slice(0, 19).replace("T", " ")}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-3">
                  <pre className="overflow-auto border bg-muted/50 p-3 text-xs max-h-80">{renderContent(v)}</pre>
                  {v.config != null && Object.keys(v.config as object).length > 0 && (
                    <pre className="overflow-auto border bg-muted/50 p-3 text-xs max-h-80">
                      {JSON.stringify(v.config, null, 2)}
                    </pre>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      <PromptUsage name={prompt.name} />
    </div>
  );
}
