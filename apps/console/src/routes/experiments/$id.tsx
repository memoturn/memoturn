import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
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
import { Skeleton } from "../../components/ui/skeleton";
import { api, type ExperimentDetail } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";

export const Route = createFileRoute("/experiments/$id")({ component: ExperimentDetailPage });

const statusTone: Record<string, "green" | "blue" | "red" | "neutral" | "amber"> = {
  COMPLETED: "green",
  RUNNING: "blue",
  PENDING: "neutral",
  FAILED: "red",
  CANCELLED: "amber",
};
const itemTone: Record<string, "green" | "blue" | "red" | "neutral"> = {
  DONE: "green",
  RUNNING: "blue",
  FAILED: "red",
  PENDING: "neutral",
};

function ExperimentDetailPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();

  const { data, isLoading, error } = useQuery({
    queryKey: ["experiment", id],
    queryFn: () => api.getExperiment(id),
    // Poll while the run is in flight so progress + results stream in.
    refetchInterval: (q) => {
      const s = (q.state.data as ExperimentDetail | undefined)?.status;
      return s === "RUNNING" || s === "PENDING" ? 2000 : false;
    },
  });
  const inFlight = data?.status === "RUNNING" || data?.status === "PENDING";
  const { data: comparison } = useQuery({
    queryKey: ["experiment-compare", id],
    queryFn: () => api.getExperimentComparison(id),
    enabled: !!data && (data.completedItems > 0 || data.failedItems > 0),
    refetchInterval: inFlight ? 3000 : false,
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelExperiment(id),
    onSuccess: () => {
      toast.success("Experiment cancelled");
      qc.invalidateQueries({ queryKey: ["experiment", id] });
    },
    onError: (e) => toast.error(String(e)),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <EmptyState title="Failed to load experiment" description={String(error)} />;
  if (!data) return <EmptyState title="Experiment not found" />;

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/experiments">Experiments</Link>
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
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
            <KindBadge tone={statusTone[data.status] ?? "neutral"}>{data.status}</KindBadge>
          </div>
          <p className="text-sm text-muted-foreground">
            <Link to="/datasets/$name" params={{ name: data.dataset }} className="hover:underline">
              {data.dataset}
            </Link>{" "}
            · {data.provider}/{data.model}
            {data.promptName && ` · prompt "${data.promptName}"`}
            {data.promptVersion != null && ` v${data.promptVersion}`}
          </p>
        </div>
        {!readOnly && inFlight && (
          <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total" value={data.totalItems} />
        <StatTile label="Completed" value={data.completedItems} />
        <StatTile label="Failed" value={data.failedItems} />
        <StatTile label="Evaluators" value={data.evaluators.length} />
      </div>

      {data.error && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{data.error}</CardContent>
        </Card>
      )}

      {comparison && comparison.runs.length > 0 && <RunComparison data={comparison} title="Results" />}

      <Card>
        <CardHeader>
          <CardTitle>Items ({data.items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {data.items.map((it) => (
              <KindBadge key={it.datasetItemId} tone={itemTone[it.status] ?? "neutral"} title={it.error || it.status}>
                {it.status}
              </KindBadge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
