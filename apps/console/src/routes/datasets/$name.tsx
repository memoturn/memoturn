import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "../../components/empty-state";
import { KindBadge } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
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
import { api } from "../../lib/api";

export const Route = createFileRoute("/datasets/$name")({ component: DatasetDetailPage });

function j(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function trunc(s: string, n = 100): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function DatasetDetailPage() {
  const { name } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dataset", name],
    queryFn: () => api.getDataset(name),
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
            <BreadcrumbPage>{data.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={data.name} description={data.description || undefined} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Runs ({data.runs.length})</h2>
        {data.runs.length === 0 ? (
          <EmptyState title="No experiment runs yet" />
        ) : (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
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
      </section>

      {data.runs.length > 0 && <Comparison name={name} />}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Items ({data.items.length})</h2>
        {data.items.length === 0 ? (
          <EmptyState title="No items yet" />
        ) : (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Input</TableHead>
                  <TableHead>Expected output</TableHead>
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
      </section>
    </div>
  );
}

function Comparison({ name }: { name: string }) {
  const { data } = useQuery({
    queryKey: ["dataset-compare", name],
    queryFn: () => api.getDatasetComparison(name),
  });
  if (!data || data.runs.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">Run comparison</h2>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Input</TableHead>
              <TableHead>Expected</TableHead>
              {data.runs.map((r) => (
                <TableHead key={r}>{r}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((it) => (
              <TableRow key={it.id}>
                <TableCell className="text-muted-foreground">{trunc(j(it.input), 80)}</TableCell>
                <TableCell className="text-muted-foreground">{trunc(j(it.expectedOutput), 80)}</TableCell>
                {it.cells.map((cell, i) => (
                  <TableCell key={data.runs[i] ?? i}>
                    {cell ? (
                      <>
                        <Link
                          to="/traces/$id"
                          params={{ id: cell.traceId }}
                          className="font-medium text-primary hover:underline"
                        >
                          {trunc(cell.output, 80) || "view trace"}
                        </Link>
                        {cell.scores.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {cell.scores.map((s, k) => (
                              <KindBadge tone="neutral" key={`${s.name}:${k}`}>
                                <span className="text-muted-foreground">{s.name}</span>
                                <span className="font-medium">{s.value != null ? s.value : s.stringValue || "—"}</span>
                              </KindBadge>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
