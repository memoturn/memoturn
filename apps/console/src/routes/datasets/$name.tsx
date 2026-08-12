import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDown, Database, Download, FlaskConical, GitBranch, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { HelpTip } from "../../components/help-tip";
import { JsonValue } from "../../components/json-value";
import { KindBadge } from "../../components/kind-badge";
import { RunComparison } from "../../components/run-comparison";
import { StatTile } from "../../components/stat-tile";
import { Timestamp } from "../../components/timestamp";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api, downloadDatasetExport } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";

export const Route = createFileRoute("/datasets/$name")({ component: DatasetDetailPage });

function DatasetDetailPage() {
  const { name } = Route.useParams();
  const readOnly = useIsReadOnly();
  const qc = useQueryClient();
  // undefined = "All runs" (no version filter); a number = a specific version's runs.
  const [version, setVersion] = useState<number | undefined>(undefined);

  const { data, isLoading, error } = useQuery({
    queryKey: ["dataset", name],
    queryFn: () => api.getDataset(name),
  });
  const { data: comparison } = useQuery({
    queryKey: ["dataset-compare", name, version ?? "all"],
    queryFn: () => api.getDatasetComparison(name, version),
    enabled: !!data && data.runs.length > 0,
  });

  const cutVersion = useMutation({
    mutationFn: (body: { label?: string; description?: string }) => api.createDatasetVersion(name, body),
    onSuccess: (v) => {
      toast.success(`Cut version ${v.version} (${v.itemCount} items)`);
      qc.invalidateQueries({ queryKey: ["dataset", name] });
      qc.invalidateQueries({ queryKey: ["dataset-compare", name] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const exportDataset = async (format: "items" | "oai-chat" | "anthropic-messages") => {
    try {
      const { skipped } = await downloadDatasetExport(name, format);
      if (skipped > 0) toast.info(`${skipped} item${skipped === 1 ? "" : "s"} without an expected output skipped`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  };

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <EmptyState title="Failed to load dataset" description={String(error)} />;
  if (!data) return <EmptyState title="Dataset not found" />;

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/datasets">Datasets</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[40ch] truncate">{data.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          {data.description && <p className="text-sm text-muted-foreground">{data.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="mr-1.5 size-4" />
                Export
                <ChevronDown className="ml-1 size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Download {data.items.length} items</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportDataset("items")}>
                Items (JSONL)
                <span className="ml-auto text-xs text-muted-foreground">backup</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportDataset("oai-chat")}>
                Fine-tuning (OpenAI chat JSONL)
                <span className="ml-auto text-xs text-muted-foreground">.jsonl</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportDataset("anthropic-messages")}>
                Fine-tuning (Anthropic messages JSONL)
                <span className="ml-auto text-xs text-muted-foreground">.jsonl</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!readOnly && <CutVersionDialog pending={cutVersion.isPending} onCut={(body) => cutVersion.mutate(body)} />}
          {!readOnly && (
            <Button asChild size="sm">
              <Link to="/experiments" search={{ dataset: data.name }}>
                <Play className="mr-1.5 size-4" /> Run experiment
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatTile
          label="Runs"
          value={data.runs.length}
          icon={FlaskConical}
          help="A run executes this dataset's items through a model and links each result back to its trace."
        />
        <StatTile
          label="Items"
          value={data.items.length}
          icon={Database}
          help="Each item is one input paired with its expected output."
        />
        <StatTile label="Versions" value={data.versions.length} icon={GitBranch} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="inline-flex items-center gap-1">
            Runs ({data.runs.length})
            <HelpTip>
              Each run executes the dataset's items through a model and links every result back to its trace for
              scoring.
            </HelpTip>
          </CardTitle>
          {data.versions.length > 0 && (
            <Select
              value={version === undefined ? "all" : String(version)}
              onValueChange={(v) => setVersion(v === "all" ? undefined : Number(v))}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All versions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All versions</SelectItem>
                {data.versions.map((v) => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    {v.label || `v${v.version}`} ({v.itemCount} items)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardHeader>
        <CardContent className={data.runs.length === 0 ? undefined : "px-0"}>
          {data.runs.length === 0 ? (
            <EmptyState title="No experiment runs yet" />
          ) : (
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Items linked</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.runs.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell>
                        <KindBadge tone="blue">{r.name}</KindBadge>
                      </TableCell>
                      <TableCell>
                        {r.version != null ? <KindBadge tone="neutral">v{r.version}</KindBadge> : "—"}
                      </TableCell>
                      <TableCell>{r.itemCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.createdAt.slice(0, 19).replace("T", " ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <RemoteRunnerCard datasetName={name} readOnly={readOnly} />

      {comparison && comparison.runs.length > 0 && <RunComparison data={comparison} />}

      <Card>
        <CardHeader>
          <CardTitle>Items ({data.items.length})</CardTitle>
        </CardHeader>
        <CardContent className={data.items.length === 0 ? undefined : "px-0"}>
          {data.items.length === 0 ? (
            <EmptyState title="No items yet" />
          ) : (
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Input</TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        Expected output
                        <HelpTip>
                          The reference answer for this input — what a correct model response should match, used as the
                          target when scoring runs.
                        </HelpTip>
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="max-w-md align-top">
                        <JsonValue value={it.input} maxHeight="max-h-40" />
                      </TableCell>
                      <TableCell className="max-w-md align-top">
                        <JsonValue value={it.expectedOutput} maxHeight="max-h-40" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CutVersionDialog({
  pending,
  onCut,
}: {
  pending: boolean;
  onCut: (body: { label?: string; description?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GitBranch className="mr-1.5 size-4" /> Cut version
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cut a new version</DialogTitle>
          <DialogDescription>
            Freezes the current items into an immutable snapshot. Experiments can pin this exact revision.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="version-label">Label (optional)</Label>
            <Input
              id="version-label"
              placeholder="golden-v2"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="version-desc">Description (optional)</Label>
            <Input
              id="version-desc"
              placeholder="What changed"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => {
              onCut({ label: label || undefined, description: description || undefined });
              setOpen(false);
              setLabel("");
              setDescription("");
            }}
          >
            Cut version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
/**
 * Remote runner — point "run this dataset" at the customer's own eval harness.
 *
 * In-platform experiments go through our provider gateway, which is useless to a team whose
 * harness already exists. Registering a runner sends them a signed trigger instead; they pull
 * the items with their own API key, run them wherever their prompts and tools live, and report
 * results back. The trigger is a pointer, so the payload stays small no matter the dataset size.
 */
function RemoteRunnerCard({ datasetName, readOnly }: { datasetName: string; readOnly: boolean }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [runName, setRunName] = useState("");
  const [secret, setSecret] = useState("");

  const { data: runner } = useQuery({
    queryKey: ["dataset-runner", datasetName],
    // A dataset without a runner is the normal case, not an error.
    queryFn: () => api.getDatasetRunner(datasetName).catch(() => null),
  });

  const save = useMutation({
    mutationFn: () => api.setDatasetRunner(datasetName, { url }),
    onSuccess: (r) => {
      // Shown once and never again — it's the receiver's only way to verify our signature.
      setSecret(r.secret);
      toast.success("Runner registered — copy the signing secret now");
      qc.invalidateQueries({ queryKey: ["dataset-runner", datasetName] });
    },
    onError: (e) => toast.error(`Failed to register runner: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDatasetRunner(datasetName),
    onSuccess: () => {
      setSecret("");
      toast.success("Runner removed");
      qc.invalidateQueries({ queryKey: ["dataset-runner", datasetName] });
    },
  });
  const trigger = useMutation({
    mutationFn: () => api.triggerRemoteRun(datasetName, { runName }),
    onSuccess: (r) => {
      if (r.accepted) toast.success(`Runner accepted "${r.runName}" (${r.itemCount} items)`);
      // A rejected trigger is not a thrown error — say so plainly rather than showing success.
      else toast.error(`Runner did not accept the run: ${r.error}`);
      qc.invalidateQueries({ queryKey: ["dataset", datasetName] });
      qc.invalidateQueries({ queryKey: ["dataset-runner", datasetName] });
    },
    onError: (e) => toast.error(`Failed to trigger run: ${String(e)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1">
          Remote runner
          <HelpTip>
            Run this dataset with your own eval harness instead of ours. We POST a signed trigger to your URL; your
            service pulls the items with its API key, runs them in your infrastructure, and reports each result to{" "}
            <code>POST /v1/dataset-run-items</code>. The trigger carries a pointer, never a copy of the dataset.
          </HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {runner ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <KindBadge tone={runner.enabled ? "green" : "neutral"}>
                {runner.enabled ? "enabled" : "disabled"}
              </KindBadge>
              <span className="font-mono text-xs text-muted-foreground">{runner.url}</span>
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => remove.mutate()}>
                Remove
              </Button>
            </div>
            {runner.lastInvokedAt && (
              <div className="text-xs text-muted-foreground">
                Last triggered <Timestamp value={runner.lastInvokedAt} />
                {runner.lastError ? (
                  <span className="ml-1 text-destructive">— {runner.lastError}</span>
                ) : (
                  <span className="ml-1">— accepted{runner.lastStatus ? ` (HTTP ${runner.lastStatus})` : ""}</span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <Input
                placeholder="run name (e.g. nightly-2026-08-12)"
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
                className="max-w-xs"
              />
              <Button disabled={readOnly || !runName.trim() || trigger.isPending} onClick={() => trigger.mutate()}>
                {trigger.isPending ? "Triggering…" : "Run remotely"}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              placeholder="https://your-harness.example/memoturn-runs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="max-w-md"
            />
            <Button disabled={readOnly || !url.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Registering…" : "Register runner"}
            </Button>
          </div>
        )}
        {secret && (
          <div className="rounded-md border border-dashed p-3 text-sm">
            <div className="mb-1 font-medium">Signing secret — shown once</div>
            <code className="break-all text-xs">{secret}</code>
            <p className="mt-1 text-xs text-muted-foreground">
              Verify each trigger with <code>{"HMAC_SHA256(secret, `<timestamp>.<body>`)"}</code> against the{" "}
              <code>X-Memoturn-Signature</code> header.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
