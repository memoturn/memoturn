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
import { HelpTip } from "../components/help-tip";
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
  provider: z.enum(["mock", "anthropic", "openai", "gemini", "bedrock", "azure", "openai_compatible"]),
  model: z.string().min(1, "Model is required"),
  prompt: z.string().min(1, "Prompt is required"),
  online: z.boolean(),
  samplingRate: z.number().min(0).max(1),
});
type EvaluatorForm = z.infer<typeof evaluatorSchema>;

const columns: ColumnDef<Evaluator>[] = [
  { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
  {
    accessorKey: "version",
    header: "Version",
    cell: ({ row }) => <KindBadge tone="neutral">v{row.original.version}</KindBadge>,
  },
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
  const { data: templates } = useQuery({
    queryKey: ["evaluator-templates"],
    queryFn: () => api.listEvaluatorTemplates(),
  });
  const { data: analytics } = useQuery({
    queryKey: ["evaluator-analytics"],
    queryFn: () => api.getEvaluatorAnalytics(30),
  });

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
        help="Define an LLM that judges a trace's input and output and records the result as an EVAL score."
      />

      <Card>
        <CardHeader>
          <CardTitle>New evaluator</CardTitle>
          <CardDescription>Define an LLM-as-judge that scores trace input/output.</CardDescription>
        </CardHeader>
        <CardContent>
          {templates && templates.length > 0 && (
            <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-4">
              <div className="space-y-1">
                <div className="text-sm font-medium">Start from a template</div>
                <div className="text-xs text-muted-foreground">
                  Pre-fill the form with a curated judge (faithfulness, hallucination, toxicity, …), then tweak and
                  save.
                </div>
              </div>
              <Select
                onValueChange={(key) => {
                  const t = templates.find((x) => x.key === key);
                  if (!t) return;
                  form.setValue("name", t.name.toLowerCase().replace(/\s+/g, "-"));
                  form.setValue("prompt", t.prompt);
                  if (t.defaultModel) form.setValue("model", t.defaultModel);
                  toast.success(`Loaded “${t.name}” — review and save`);
                }}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Choose a template…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
                          <SelectItem value="gemini">gemini</SelectItem>
                          <SelectItem value="bedrock">bedrock</SelectItem>
                          <SelectItem value="azure">azure</SelectItem>
                          <SelectItem value="openai_compatible">openai_compatible</SelectItem>
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
                      <FormLabel>
                        <span className="inline-flex items-center gap-1">
                          Online
                          <HelpTip>
                            Runs the evaluator automatically on sampled production traces as they arrive.
                          </HelpTip>
                        </span>
                      </FormLabel>
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
                        <FormLabel>
                          <span className="inline-flex items-center gap-1">
                            Sampling rate
                            <HelpTip>
                              Fraction of traces evaluated, chosen by a stable hash per trace rather than at random.
                            </HelpTip>
                          </span>
                        </FormLabel>
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

      {analytics && analytics.summary.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              Score trends
              <HelpTip>
                Average EVAL score and the number of scores each evaluator produced over the last 30 days.
              </HelpTip>
            </CardTitle>
            <CardDescription>Average EVAL score and run count per evaluator over the last 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-medium">Evaluator</th>
                  <th className="py-2 text-right font-medium">Avg score</th>
                  <th className="py-2 text-right font-medium">Scores</th>
                </tr>
              </thead>
              <tbody>
                {analytics.summary.map((s) => (
                  <tr key={s.name} className="border-b last:border-0">
                    <td className="py-2 font-medium">{s.name}</td>
                    <td className="py-2 text-right tabular-nums">{s.avgValue.toFixed(3)}</td>
                    <td className="py-2 text-right tabular-nums">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

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
