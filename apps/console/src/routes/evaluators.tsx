import { zodResolver } from "@hookform/resolvers/zod";
import type { Evaluator } from "@memoturn/contracts";
import { EXPR_BUILTIN_NAMES } from "@memoturn/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ClipboardCheck, Plus, X } from "lucide-react";
import { useState } from "react";
import { type UseFormReturn, useFieldArray, useForm } from "react-hook-form";
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

const PROVIDERS = ["mock", "anthropic", "openai", "gemini", "bedrock", "azure", "openai_compatible"] as const;
const providerEnum = z.enum(PROVIDERS);

const evaluatorSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    // LLM = judge prompt + model (costs a provider call). CODE = a deterministic expression,
    // evaluated locally: free, instant, reproducible, no provider key needed.
    kind: z.enum(["LLM", "CODE"]),
    provider: providerEnum,
    model: z.string().min(1, "Model is required"),
    prompt: z.string(),
    expression: z.string(),
    online: z.boolean(),
    samplingRate: z.number().min(0).max(1),
    scope: z.enum(["trace", "thread"]),
    cooldownSeconds: z.number().int().min(0),
    // Optional LLM jury: when non-empty, the evaluator becomes an ensemble (mean of votes).
    jurors: z.array(z.object({ provider: providerEnum, model: z.string().min(1, "Model required") })),
  })
  // Each kind requires a different field; validating conditionally keeps one form serving both
  // instead of splitting into two nearly-identical ones.
  .superRefine((v, ctx) => {
    if (v.kind === "LLM" && v.prompt.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["prompt"], message: "Prompt is required" });
    }
    if (v.kind === "CODE" && v.expression.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["expression"], message: "Expression is required" });
    }
  });
type EvaluatorForm = z.infer<typeof evaluatorSchema>;

const columns: ColumnDef<Evaluator>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{row.original.name}</span>
        {row.original.jurors.length > 0 && <KindBadge tone="violet">jury ×{row.original.jurors.length}</KindBadge>}
      </div>
    ),
  },
  {
    accessorKey: "version",
    header: "Version",
    cell: ({ row }) => <KindBadge tone="neutral">v{row.original.version}</KindBadge>,
  },
  {
    accessorKey: "provider",
    header: "Provider",
    cell: ({ row }) =>
      row.original.kind === "CODE" ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <KindBadge tone="blue">{row.original.provider}</KindBadge>
      ),
  },
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) =>
      row.original.kind === "CODE" ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span>{row.original.model}</span>
      ),
  },
  {
    accessorKey: "scope",
    header: "Scope",
    cell: ({ row }) =>
      row.original.scope === "thread" ? <KindBadge tone="amber">thread</KindBadge> : <span>trace</span>,
  },
  {
    accessorKey: "online",
    header: "Online",
    cell: ({ row }) => {
      if (!row.original.online) return "—";
      return row.original.scope === "thread" ? (
        <KindBadge tone="green">every {row.original.cooldownSeconds}s idle</KindBadge>
      ) : (
        <KindBadge tone="green">{Math.round(row.original.samplingRate * 100)}%</KindBadge>
      );
    },
  },
  {
    accessorKey: "kind",
    header: "Kind",
    cell: ({ row }) => (row.original.kind === "CODE" ? <KindBadge tone="teal">code</KindBadge> : <span>LLM</span>),
  },
  {
    accessorKey: "prompt",
    header: "Source",
    // A CODE evaluator's prompt is empty and its provider/model unused — show the check instead.
    cell: ({ row }) =>
      row.original.kind === "CODE" ? (
        <span className="font-mono text-xs text-muted-foreground">{row.original.expression.slice(0, 70)}</span>
      ) : (
        <span className="text-muted-foreground">{row.original.prompt.slice(0, 70)}</span>
      ),
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
  const { data: presets } = useQuery({ queryKey: ["expr-presets"], queryFn: () => api.listExprPresets() });

  const form = useForm<EvaluatorForm>({
    resolver: zodResolver(evaluatorSchema),
    defaultValues: {
      name: "",
      kind: "LLM",
      provider: "mock",
      model: "mock-1",
      prompt: "Score how well the output answers the input. 1 = perfect, 0 = wrong.",
      expression: "",
      online: false,
      samplingRate: 1,
      scope: "trace",
      cooldownSeconds: 900,
      jurors: [],
    },
  });
  const online = form.watch("online");
  const scope = form.watch("scope");
  const kind = form.watch("kind");
  const isCode = kind === "CODE";
  const jurors = useFieldArray({ control: form.control, name: "jurors" });

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
        description="Score traces automatically — with an LLM judge, or a deterministic code check that costs nothing to run."
        help="An evaluator scores a trace's input/output and records an EVAL score. LLM judges handle subjective quality; code checks handle deterministic rules (regex, JSON shape, length, exact match) for free."
      />

      <Card>
        <CardHeader>
          <CardTitle>New evaluator</CardTitle>
          <CardDescription>Define an evaluator that scores trace input/output.</CardDescription>
        </CardHeader>
        <CardContent>
          <FormField
            control={form.control}
            name="kind"
            render={({ field }) => (
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Kind</span>
                <div className="inline-flex rounded-md border p-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={field.value === "LLM" ? "secondary" : "ghost"}
                    onClick={() => field.onChange("LLM")}
                  >
                    LLM judge
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={field.value === "CODE" ? "secondary" : "ghost"}
                    onClick={() => field.onChange("CODE")}
                  >
                    Code check
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  {field.value === "CODE"
                    ? "Deterministic expression — free, instant, no model call."
                    : "An LLM scores the output. Costs a provider call per evaluation."}
                </span>
              </div>
            )}
          />
          {isCode && presets && presets.length > 0 && (
            <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-4">
              <div className="space-y-1">
                <div className="text-sm font-medium">Start from a check</div>
                <div className="text-xs text-muted-foreground">
                  Fills in an expression you can then edit — the menu is a starting point, not a limit.
                </div>
              </div>
              <Select
                onValueChange={(key) => {
                  const preset = presets.find((x) => x.key === key);
                  if (!preset) return;
                  // Placeholders are left in place deliberately: the author must fill them in, and
                  // an unfilled one fails to compile loudly rather than scoring on a literal.
                  form.setValue("name", preset.name);
                  form.setValue("expression", preset.expression);
                  toast.success(
                    preset.placeholders.length > 0
                      ? `Loaded “${preset.name}” — replace ${preset.placeholders.map((ph) => `{{${ph.key}}}`).join(", ")}`
                      : `Loaded “${preset.name}” — review and save`,
                  );
                }}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Choose a check…" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.key} value={preset.key}>
                      {preset.name} — {preset.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!isCode && templates && templates.length > 0 && (
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
                {!isCode && (
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
                )}
                {!isCode && (
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
                )}
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
                <FormField
                  control={form.control}
                  name="scope"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <span className="inline-flex items-center gap-1">
                          Scope
                          <HelpTip>
                            <strong>Trace</strong> scores each trace's input/output. <strong>Thread</strong> scores a
                            whole conversation (all traces sharing a session id) once it has been idle for the cooldown
                            — use it for conversation-quality metrics.
                          </HelpTip>
                        </span>
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="trace">trace (per trace)</SelectItem>
                          <SelectItem value="thread">thread (per conversation)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {online && scope === "trace" && (
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
                {online && scope === "thread" && (
                  <FormField
                    control={form.control}
                    name="cooldownSeconds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <span className="inline-flex items-center gap-1">
                            Cooldown (seconds)
                            <HelpTip>
                              How long a session must be idle before the whole conversation is judged, so multi-turn
                              chats settle before scoring. Default 900 (15 min).
                            </HelpTip>
                          </span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="60"
                            min="0"
                            {...field}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                          />
                        </FormControl>
                        <FormDescription>Idle time before a conversation is scored.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
              {!isCode && (
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
              )}
              {isCode && <ExpressionEditor form={form} />}

              <div className={`space-y-2 rounded-lg border border-dashed p-4 ${isCode ? "hidden" : ""}`}>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="inline-flex items-center gap-1 text-sm font-medium">
                      LLM jury (optional)
                      <HelpTip>
                        Add jurors to turn this into an ensemble: the same prompt runs against every juror and the score
                        is the mean of their votes, reducing single-judge variance. Leave empty for a single judge.
                      </HelpTip>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      The provider/model above casts a vote too; jurors add more.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => jurors.append({ provider: "mock", model: "mock-1" })}
                  >
                    <Plus className="mr-1 h-4 w-4" /> Add juror
                  </Button>
                </div>
                {jurors.fields.map((f, i) => (
                  <div key={f.id} className="flex items-end gap-2">
                    <FormField
                      control={form.control}
                      name={`jurors.${i}.provider`}
                      render={({ field }) => (
                        <FormItem className="w-44">
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {PROVIDERS.map((p) => (
                                <SelectItem key={p} value={p}>
                                  {p}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`jurors.${i}.model`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input placeholder="model id" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => jurors.remove(i)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

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

/**
 * Expression editor for CODE evaluators, with a dry-run panel.
 *
 * The sample item is deliberately part of the editor rather than a separate page: an expression
 * you can't try is a guess, and the failure modes here (a typo'd builtin, a result that isn't
 * score-shaped) are much easier to understand against a concrete output than from a message.
 */
function ExpressionEditor({ form }: { form: UseFormReturn<EvaluatorForm> }) {
  const [sampleOutput, setSampleOutput] = useState('{"status":"ok","id":"ABC-1234"}');
  const [sampleExpected, setSampleExpected] = useState("");
  const expression = form.watch("expression");

  const test = useMutation({
    mutationFn: () =>
      api.testExpression({
        expression,
        input: "",
        output: sampleOutput,
        expectedOutput: sampleExpected,
        metadata: {},
      }),
    onError: (e) => toast.error(`Test failed: ${String(e)}`),
  });
  const result = test.data;

  return (
    <div className="space-y-3">
      <FormField
        control={form.control}
        name="expression"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              <span className="inline-flex items-center gap-1">
                Expression
                <HelpTip>
                  Evaluated against <code>output</code>, <code>input</code>, <code>expected</code>, and{" "}
                  <code>metadata</code>. Return a boolean (pass/fail → 1/0) or a number between 0 and 1 for a graded
                  score. No model is called.
                </HelpTip>
              </span>
            </FormLabel>
            <FormControl>
              <Textarea rows={3} className="font-mono text-xs" placeholder='matches(output, "^[A-Z]{3}")' {...field} />
            </FormControl>
            <FormDescription>
              Functions: {EXPR_BUILTIN_NAMES.join(", ")}. Operators: and, or, not, ==, !=, &lt;, &lt;=, &gt;, &gt;=, +,
              -, *, /, %, and a ? b : c.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="space-y-2 rounded-lg border border-dashed p-4">
        <div className="text-sm font-medium">Try it</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Sample output</span>
            <Textarea
              rows={2}
              className="font-mono text-xs"
              value={sampleOutput}
              onChange={(e) => setSampleOutput(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Sample expected (optional)</span>
            <Textarea
              rows={2}
              className="font-mono text-xs"
              value={sampleExpected}
              onChange={(e) => setSampleExpected(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!expression || test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Running…" : "Run check"}
          </Button>
          {result && (
            <div className="flex items-center gap-2 text-sm">
              {result.ok ? (
                <>
                  <KindBadge tone={result.score === 1 ? "green" : result.score === 0 ? "red" : "blue"}>
                    score {result.score}
                  </KindBadge>
                  <span className="font-mono text-xs text-muted-foreground">→ {result.value}</span>
                </>
              ) : (
                <>
                  <KindBadge tone="red">error</KindBadge>
                  {/* Show the raw value too when there was one — "produced a string" is far more
                      actionable next to the string it produced. */}
                  {result.value !== null && (
                    <span className="font-mono text-xs text-muted-foreground">→ {result.value}</span>
                  )}
                  <span className="text-xs text-destructive">{result.error}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
