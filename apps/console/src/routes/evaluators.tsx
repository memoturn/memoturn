import { zodResolver } from "@hookform/resolvers/zod";
import type { Evaluator } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ClipboardCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/evaluators")({ component: EvaluatorsPage });

const evaluatorSchema = z.object({
  name: z.string().min(1, "Name is required"),
  provider: z.enum(["mock", "anthropic", "openai"]),
  model: z.string().min(1, "Model is required"),
  prompt: z.string().min(1, "Prompt is required"),
  online: z.boolean(),
  samplingRate: z.number().min(0).max(1),
});
type EvaluatorForm = z.infer<typeof evaluatorSchema>;

const columns: ColumnDef<Evaluator>[] = [
  { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
  {
    accessorKey: "provider",
    header: "Provider",
    cell: ({ row }) => <KindBadge tone="blue">{row.original.provider}</KindBadge>,
  },
  { accessorKey: "model", header: "Model" },
  {
    accessorKey: "online",
    header: "Online",
    cell: ({ row }) =>
      row.original.online ? <KindBadge tone="green">{Math.round(row.original.samplingRate * 100)}%</KindBadge> : "—",
  },
  {
    accessorKey: "prompt",
    header: "Prompt",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.prompt.slice(0, 70)}</span>,
  },
];

function EvaluatorsPage() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: evaluators } = useQuery({ queryKey: ["evaluators"], queryFn: () => api.listEvaluators() });

  const form = useForm<EvaluatorForm>({
    resolver: zodResolver(evaluatorSchema),
    defaultValues: {
      name: "",
      provider: "mock",
      model: "mock-1",
      prompt: "Score how well the output answers the input. 1 = perfect, 0 = wrong.",
      online: false,
      samplingRate: 1,
    },
  });
  const online = form.watch("online");

  const create = useMutation({
    mutationFn: (values: EvaluatorForm) => api.createEvaluator(values),
    onSuccess: () => {
      toast.success("Evaluator created");
      form.reset();
      qc.invalidateQueries({ queryKey: ["evaluators"] });
    },
    onError: (e) => toast.error(`Failed to create evaluator: ${String(e)}`),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Evaluators"
        description="LLM-as-judge evaluators. Run them over a trace's input/output to record an EVAL score."
      />

      <Card>
        <CardHeader>
          <CardTitle>New evaluator</CardTitle>
          <CardDescription>Define an LLM-as-judge that scores trace input/output.</CardDescription>
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
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="helpfulness" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Provider</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="mock">mock</SelectItem>
                          <SelectItem value="anthropic">anthropic</SelectItem>
                          <SelectItem value="openai">openai</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="model"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model</FormLabel>
                      <FormControl>
                        <Input placeholder="mock-1" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="online"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Online</FormLabel>
                      <FormControl>
                        <div className="flex h-10 items-center gap-3">
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                          <span className="text-sm text-muted-foreground">Run automatically on sampled traces</span>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {online && (
                  <FormField
                    control={form.control}
                    name="samplingRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sampling rate</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            max="1"
                            {...field}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription>Fraction of traces evaluated (0–1).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
              <FormField
                control={form.control}
                name="prompt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prompt</FormLabel>
                    <FormControl>
                      <Textarea rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={readOnly || create.isPending}>
                {create.isPending ? "Saving…" : "Create"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Evaluators ({evaluators?.length ?? 0})</h2>
        {!evaluators || evaluators.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No evaluators yet"
            description="Create one above to start scoring traces."
          />
        ) : (
          <DataTable columns={columns} data={evaluators} filterColumn="name" filterPlaceholder="Filter evaluators…" />
        )}
      </div>
    </div>
  );
}
