import { Link } from "@tanstack/react-router";
import type { ExperimentComparison } from "../lib/api";
import { KindBadge } from "./kind-badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

function j(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function trunc(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Items × runs grid: every dataset item's input/expected alongside each run's output +
 * scores. Shared by the dataset detail page and the experiment detail page (both pass an
 * already-fetched comparison), so the exact same grid renders in both places.
 */
export function RunComparison({ data, title = "Run comparison" }: { data: ExperimentComparison; title?: string }) {
  if (data.runs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto border-t">
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
                  <TableCell className="text-muted-foreground">{trunc(j(it.input))}</TableCell>
                  <TableCell className="text-muted-foreground">{trunc(j(it.expectedOutput))}</TableCell>
                  {it.cells.map((cell, i) => (
                    <TableCell key={data.runs[i] ?? i}>
                      {cell ? (
                        <>
                          <Link
                            to="/traces/$id"
                            params={{ id: cell.traceId }}
                            className="font-medium text-primary hover:underline"
                          >
                            {trunc(cell.output) || "view trace"}
                          </Link>
                          {cell.scores.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {cell.scores.map((s, k) => (
                                <KindBadge tone="neutral" key={`${s.name}:${k}`}>
                                  <span className="text-muted-foreground">{s.name}</span>
                                  <span className="font-medium">
                                    {s.value != null ? s.value : s.stringValue || "—"}
                                  </span>
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
      </CardContent>
    </Card>
  );
}
