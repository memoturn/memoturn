import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, FlaskConical, GitBranch, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { HelpTip } from "../../components/help-tip";
import { KindBadge } from "../../components/kind-badge";
import { RunComparison } from "../../components/run-comparison";
import { StatTile } from "../../components/stat-tile";
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
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";

export const Route = createFileRoute("/datasets/$name")({ component: DatasetDetailPage });

function j(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

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

      <div className="grid grid-cols-3 gap-4 sm:max-w-lg">
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
                      <TableCell>{j(it.input)}</TableCell>
                      <TableCell>{j(it.expectedOutput)}</TableCell>
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
