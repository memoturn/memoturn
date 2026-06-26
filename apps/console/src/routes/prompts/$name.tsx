import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "../../components/empty-state";
import { KindBadge } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Skeleton } from "../../components/ui/skeleton";
import { api, type PromptVersionDetail } from "../../lib/api";

export const Route = createFileRoute("/prompts/$name")({ component: PromptDetailPage });

function renderContent(v: PromptVersionDetail): string {
  if (v.type === "CHAT" && Array.isArray(v.content)) {
    return (v.content as { role: string; content: string }[]).map((m) => `[${m.role}] ${m.content}`).join("\n");
  }
  return String(v.content ?? "");
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
            <BreadcrumbPage>{prompt.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={prompt.name} />

      <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Folder</dt>
        <dd>{prompt.folder || "—"}</dd>
        <dt className="text-muted-foreground">Latest</dt>
        <dd>v{prompt.latestVersion}</dd>
        <dt className="text-muted-foreground">Channels</dt>
        <dd className="flex flex-wrap gap-1">
          {prompt.channels.map((c) => (
            <KindBadge key={c.label} tone="blue">
              {c.label} → v{c.version}
            </KindBadge>
          ))}
        </dd>
      </dl>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Versions</h2>
        <Accordion type="multiple" className="rounded-lg border px-4">
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
                <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs max-h-80">
                  {renderContent(v)}
                </pre>
                {v.config != null && Object.keys(v.config as object).length > 0 && (
                  <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs max-h-80">
                    {JSON.stringify(v.config, null, 2)}
                  </pre>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </div>
  );
}
