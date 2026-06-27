import { zodResolver } from "@hookform/resolvers/zod";
import type { ReviewItem, ReviewQueue, ScoreConfig } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, CheckCircle2, ClipboardList, Hourglass, ListChecks, SkipForward, UserCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { StatTile } from "../components/stat-tile";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { api } from "../lib/api";
import { useSession } from "../lib/auth";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/review")({ component: ReviewPage });

const queueSchema = z.object({
  name: z.string().min(1, "Queue name is required"),
  scoreName: z.string().min(1, "Score name is required"),
});
type QueueForm = z.infer<typeof queueSchema>;

function pretty(v: string): string {
  if (!v) return "—";
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

function ReviewCard({
  queue,
  item,
  config,
  myId,
  readOnly,
  onDone,
}: {
  queue: string;
  item: ReviewItem;
  config?: ScoreConfig;
  myId?: string;
  readOnly: boolean;
  onDone: () => void;
}) {
  const categorical = config?.dataType === "CATEGORICAL" && config.categories.length > 0;
  const [value, setValue] = useState(1);
  const [stringValue, setStringValue] = useState(config?.categories[0] ?? "");
  const [comment, setComment] = useState("");
  const submit = useMutation({
    mutationFn: () =>
      api.submitReviewScore(queue, item.id, categorical ? { stringValue, comment } : { value, comment }),
    onSuccess: () => {
      toast.success("Score submitted");
      onDone();
    },
    onError: (e) => toast.error(`Failed to submit score: ${String(e)}`),
  });
  const assign = useMutation({
    mutationFn: (assigneeId?: string) => api.assignReviewItem(queue, item.id, assigneeId),
    onSuccess: onDone,
    onError: (e) => toast.error(`Failed to assign: ${String(e)}`),
  });
  const mine = item.assigneeId && item.assigneeId === myId;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button asChild variant="link" size="sm" className="h-auto p-0 font-medium">
            <Link to="/traces/$id" params={{ id: item.traceId }}>
              {item.trace.name || item.traceId.slice(0, 8)}
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
          {item.assigneeId ? (
            <>
              <KindBadge tone="blue">{mine ? "assigned to you" : "assigned"}</KindBadge>
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => assign.mutate("")}>
                unassign
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => assign.mutate(undefined)}>
              assign to me
            </Button>
          )}
        </div>
        {item.trace.input && (
          <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs max-h-60 whitespace-pre-wrap">
            {pretty(item.trace.input)}
          </pre>
        )}
        {item.trace.output && (
          <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs max-h-60 whitespace-pre-wrap">
            {pretty(item.trace.output)}
          </pre>
        )}
        <div className="flex flex-wrap items-end gap-2">
          {categorical ? (
            <Select value={stringValue} onValueChange={setStringValue}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {config!.categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              type="number"
              step="0.1"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="w-24"
              aria-label="score value"
            />
          )}
          <Input
            placeholder="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="max-w-xs"
          />
          <Button disabled={readOnly || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Saving…" : "Submit score"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewPage() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: session } = useSession();
  const myId = session?.user.id;
  const { data: queues } = useQuery({ queryKey: ["review-queues"], queryFn: () => api.listReviewQueues() });
  const { data: throughput } = useQuery({
    queryKey: ["review-analytics"],
    queryFn: () => api.getReviewAnalytics(),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  const form = useForm<QueueForm>({
    resolver: zodResolver(queueSchema),
    defaultValues: { name: "", scoreName: "human-rating" },
  });
  const create = useMutation({
    mutationFn: (values: QueueForm) => api.createReviewQueue(values),
    onSuccess: () => {
      toast.success("Review queue created");
      form.reset({ name: "", scoreName: "human-rating" });
      qc.invalidateQueries({ queryKey: ["review-queues"] });
    },
    onError: (e) => toast.error(`Failed to create queue: ${String(e)}`),
  });

  const { data: items } = useQuery({
    queryKey: ["review-items", selected, mineOnly],
    queryFn: () => api.listReviewItems(selected!, mineOnly ? { assignee: "me" } : {}),
    enabled: !!selected,
    refetchInterval: 5_000,
  });
  const { data: scoreConfigs } = useQuery({ queryKey: ["score-configs"], queryFn: () => api.listScoreConfigs() });
  const queueConfig = scoreConfigs?.find((s) => s.name === items?.queue.scoreName);

  const columns: ColumnDef<ReviewQueue>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium text-primary">{row.original.name}</span>,
    },
    { accessorKey: "scoreName", header: "Score" },
    { accessorKey: "pending", header: "Pending" },
    { accessorKey: "done", header: "Done" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Review queues"
        description="Human-in-the-loop annotation. Submitting a review writes an ANNOTATION score on the trace."
      />

      {throughput && throughput.totals.total > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Throughput</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Total items" value={throughput.totals.total} icon={ListChecks} />
            <StatTile label="Pending" value={throughput.totals.pending} icon={Hourglass} />
            <StatTile label="Done" value={throughput.totals.done} icon={CheckCircle2} />
            <StatTile label="Skipped" value={throughput.totals.skipped} icon={SkipForward} />
          </div>
          {throughput.queues.length > 0 && (
            <Card>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 font-medium">Queue</th>
                      <th className="py-2 text-right font-medium">Pending</th>
                      <th className="py-2 text-right font-medium">Done</th>
                      <th className="py-2 text-right font-medium">Skipped</th>
                      <th className="py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {throughput.queues.map((q) => (
                      <tr key={q.queueName} className="border-b last:border-0">
                        <td className="py-2 font-medium">{q.queueName}</td>
                        <td className="py-2 text-right tabular-nums">{q.pending}</td>
                        <td className="py-2 text-right tabular-nums">{q.done}</td>
                        <td className="py-2 text-right tabular-nums">{q.skipped}</td>
                        <td className="py-2 text-right tabular-nums">{q.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New queue</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Queue name</FormLabel>
                      <FormControl>
                        <Input placeholder="my-review-queue" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="scoreName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Score name</FormLabel>
                      <FormControl>
                        <Input placeholder="human-rating" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" disabled={readOnly || create.isPending}>
                {create.isPending ? "Saving…" : "Create"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Queues ({queues?.length ?? 0})</h2>
        {!queues || queues.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No review queues yet"
            description="Create one above to get started."
          />
        ) : (
          <DataTable
            columns={columns}
            data={queues}
            filterColumn="name"
            filterPlaceholder="Filter queues…"
            onRowClick={(q) => setSelected(q.name)}
          />
        )}
      </div>

      {selected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">
              Reviewing: {selected} ({items?.items.length ?? 0} pending)
            </h2>
            <div className="flex items-center gap-2">
              <Checkbox id="mine-only" checked={mineOnly} onCheckedChange={(c) => setMineOnly(c === true)} />
              <Label htmlFor="mine-only" className="text-muted-foreground">
                assigned to me only
              </Label>
            </div>
          </div>
          {items && items.items.length === 0 ? (
            <EmptyState icon={UserCheck} title="Nothing to review" description="No pending items in this queue." />
          ) : (
            <div className="space-y-3">
              {items?.items.map((item) => (
                <ReviewCard
                  key={item.id}
                  queue={selected}
                  item={item}
                  config={queueConfig}
                  myId={myId}
                  readOnly={readOnly}
                  onDone={() => {
                    qc.invalidateQueries({ queryKey: ["review-items", selected] });
                    qc.invalidateQueries({ queryKey: ["review-queues"] });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
