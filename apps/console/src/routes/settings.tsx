import { zodResolver } from "@hookform/resolvers/zod";
import type {
  AlertRule,
  ApiKey,
  Automation,
  ModelPrice,
  ModelPriceList,
  ScoreConfig,
  Webhook,
} from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { BellRing, Copy, DollarSign, KeyRound, ListChecks, Plug, Webhook as WebhookIcon, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AccountSecurity } from "../components/account-security";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { ProjectAccess } from "../components/project-access";
import { ProjectGuardrails } from "../components/project-guardrails";
import { ProviderIcon } from "../components/provider-icon";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { WebhookLogButton } from "../components/webhook-deliveries";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

type ModelPriceBuiltin = ModelPriceList["builtins"][number];

const apiKeySchema = z.object({
  name: z.string(),
  scopes: z.array(z.string()).min(1, "Select at least one scope"),
  expiresInDays: z.string(),
  rateLimitPerMinute: z.string(),
});
type ApiKeyForm = z.infer<typeof apiKeySchema>;

const providerSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "bedrock", "azure", "openai_compatible"]),
  apiKey: z.string(),
  baseUrl: z.string(),
  region: z.string(),
});
type ProviderForm = z.infer<typeof providerSchema>;

const webhookSchema = z.object({ url: z.string().min(1, "URL is required"), threshold: z.string() });
type WebhookForm = z.infer<typeof webhookSchema>;

const automationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  trigger: z.string(),
  action: z.string(),
  target: z.string().min(1, "Target URL is required"),
  threshold: z.string(),
  filter: z.string(),
});
type AutomationForm = z.infer<typeof automationSchema>;

const alertSchema = z.object({
  name: z.string().min(1, "Name is required"),
  metric: z.string(),
  comparator: z.string(),
  threshold: z.string().min(1, "Threshold is required"),
  window: z.string(),
  channelType: z.string(),
  channelTarget: z.string().min(1, "Channel target is required"),
});
type AlertForm = z.infer<typeof alertSchema>;

const budgetSchema = z.object({
  monthlyUsd: z.string().min(1, "Budget is required"),
  channelType: z.string(),
  channelTarget: z.string().min(1, "Channel target is required"),
});
type BudgetForm = z.infer<typeof budgetSchema>;

const scoreSchema = z.object({
  name: z.string().min(1, "Name is required"),
  dataType: z.string(),
  categories: z.string(),
});
type ScoreForm = z.infer<typeof scoreSchema>;

const pricingSchema = z.object({
  pattern: z.string().min(1, "Pattern is required"),
  provider: z.string(),
  inputPerMTok: z.string().min(1, "Required"),
  outputPerMTok: z.string().min(1, "Required"),
});
type PricingForm = z.infer<typeof pricingSchema>;

function SettingsPage() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();

  // ── API keys ──────────────────────────────────────────────────────────────
  const { data: apiKeys } = useQuery({ queryKey: ["api-keys"], queryFn: () => api.listApiKeys() });
  const [newSecret, setNewSecret] = useState<{ publicKey: string; secretKey: string } | null>(null);
  const apiKeyForm = useForm<ApiKeyForm>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: { name: "", scopes: ["read", "write", "ingest"], expiresInDays: "", rateLimitPerMinute: "" },
  });
  const createKey = useMutation({
    mutationFn: (body: {
      name?: string;
      scopes?: string[];
      expiresInDays?: number | null;
      rateLimitPerMinute?: number | null;
    }) => api.createApiKey(body),
    onSuccess: (k) => {
      setNewSecret({ publicKey: k.publicKey, secretKey: k.secretKey });
      toast.success("API key created — copy the secret now");
      apiKeyForm.reset();
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(`Failed to create key: ${String(e)}`),
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      toast.success("API key revoked");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(`Failed to revoke key: ${String(e)}`),
  });
  const apiKeyColumns: ColumnDef<ApiKey>[] = [
    { accessorKey: "name", header: "Name", cell: ({ row }) => row.original.name || "—" },
    {
      accessorKey: "publicKey",
      header: "Public key",
      cell: ({ row }) => <code className="text-xs">{row.original.publicKey}</code>,
    },
    {
      accessorKey: "secretHint",
      header: "Secret",
      cell: ({ row }) => <span className="text-muted-foreground">sk-…{row.original.secretHint}</span>,
    },
    {
      accessorKey: "scopes",
      header: "Scopes",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.scopes.join(", ")}</span>,
    },
    {
      accessorKey: "expiresAt",
      header: "Expires",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.expiresAt ? row.original.expiresAt.slice(0, 10) : "never"}
        </span>
      ),
    },
    {
      accessorKey: "rateLimitPerMinute",
      header: "Rate/min",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.rateLimitPerMinute ?? "—"}</span>,
    },
    {
      accessorKey: "lastUsedAt",
      header: "Last used",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.lastUsedAt ? row.original.lastUsedAt.slice(0, 19).replace("T", " ") : "never"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || revokeKey.isPending}
          onClick={() => revokeKey.mutate(row.original.id)}
        >
          Revoke
        </Button>
      ),
    },
  ];

  // ── Providers ─────────────────────────────────────────────────────────────
  const { data: providers } = useQuery({ queryKey: ["providers"], queryFn: () => api.listProviders() });
  const providerForm = useForm<ProviderForm>({
    resolver: zodResolver(providerSchema),
    defaultValues: { provider: "anthropic", apiKey: "", baseUrl: "", region: "" },
  });
  const providerKind = providerForm.watch("provider");
  const saveProvider = useMutation({
    mutationFn: (v: ProviderForm) =>
      api.addProvider({
        provider: v.provider,
        apiKey: v.apiKey || undefined,
        baseUrl: v.baseUrl || undefined,
        region: v.region || undefined,
      }),
    onSuccess: () => {
      toast.success("Provider key saved");
      providerForm.reset();
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e) => toast.error(`Failed to save provider: ${String(e)}`),
  });

  // ── Retention ─────────────────────────────────────────────────────────────
  const { data: retention } = useQuery({ queryKey: ["retention"], queryFn: () => api.getRetention() });
  const [days, setDays] = useState<number | null>(null);
  const daysValue = days ?? retention?.days ?? 0;
  const saveRetention = useMutation({
    mutationFn: () => api.setRetention(daysValue),
    onSuccess: () => {
      toast.success("Retention saved");
      qc.invalidateQueries({ queryKey: ["retention"] });
    },
    onError: (e) => toast.error(`Failed to save retention: ${String(e)}`),
  });

  // ── Ingest sampling ───────────────────────────────────────────────────────
  const { data: sampling } = useQuery({ queryKey: ["sampling"], queryFn: () => api.getSampling() });
  const [rate, setRate] = useState<number | null>(null);
  const rateValue = rate ?? sampling?.rate ?? 100;
  const saveSampling = useMutation({
    mutationFn: () => api.setSampling(rateValue),
    onSuccess: () => {
      toast.success("Sampling saved");
      qc.invalidateQueries({ queryKey: ["sampling"] });
    },
    onError: (e) => toast.error(`Failed to save sampling: ${String(e)}`),
  });

  // ── Scheduled exports ─────────────────────────────────────────────────────
  const { data: schedExport } = useQuery({ queryKey: ["scheduled-export"], queryFn: () => api.getScheduledExport() });
  const [seEnabled, setSeEnabled] = useState<boolean | null>(null);
  const [seEnv, setSeEnv] = useState<string | null>(null);
  const [seLimit, setSeLimit] = useState<number | null>(null);
  const seEnabledValue = seEnabled ?? schedExport?.enabled ?? false;
  const seEnvValue = seEnv ?? schedExport?.environment ?? "";
  const seLimitValue = seLimit ?? schedExport?.limit ?? 1000;
  const saveSchedExport = useMutation({
    mutationFn: () => api.setScheduledExport({ enabled: seEnabledValue, environment: seEnvValue, limit: seLimitValue }),
    onSuccess: () => {
      toast.success("Scheduled export saved");
      qc.invalidateQueries({ queryKey: ["scheduled-export"] });
    },
    onError: (e) => toast.error(`Failed to save: ${String(e)}`),
  });
  const runSchedExport = useMutation({
    mutationFn: () => api.runScheduledExport(),
    onSuccess: () => {
      toast.success("Export started");
      qc.invalidateQueries({ queryKey: ["scheduled-export"] });
    },
    onError: (e) => toast.error(`Failed to export: ${String(e)}`),
  });

  // ── Analytics sink ────────────────────────────────────────────────────────
  const { data: analytics } = useQuery({ queryKey: ["analytics-sink"], queryFn: () => api.getAnalyticsSink() });
  const [anEnabled, setAnEnabled] = useState<boolean | null>(null);
  const [anHost, setAnHost] = useState<string | null>(null);
  const [anKey, setAnKey] = useState("");
  const anEnabledValue = anEnabled ?? analytics?.enabled ?? false;
  const anHostValue = anHost ?? analytics?.host ?? "https://us.i.posthog.com";
  const saveAnalytics = useMutation({
    mutationFn: () =>
      api.setAnalyticsSink({ enabled: anEnabledValue, host: anHostValue, apiKey: anKey || analytics?.apiKey }),
    onSuccess: () => {
      setAnKey("");
      toast.success("Event sink saved");
      qc.invalidateQueries({ queryKey: ["analytics-sink"] });
    },
    onError: (e) => toast.error(`Failed to save: ${String(e)}`),
  });

  // ── Masking ───────────────────────────────────────────────────────────────
  const { data: masking } = useQuery({ queryKey: ["masking"], queryFn: () => api.getMaskingPolicy() });
  const [maskEnabled, setMaskEnabled] = useState<boolean | null>(null);
  const [maskBuiltins, setMaskBuiltins] = useState<string[] | null>(null);
  const [maskCustom, setMaskCustom] = useState<string | null>(null);
  const [maskRedact, setMaskRedact] = useState<string | null>(null);
  const maskEnabledVal = maskEnabled ?? masking?.enabled ?? false;
  const maskBuiltinsVal = maskBuiltins ?? masking?.builtins ?? [];
  const maskCustomVal = maskCustom ?? (masking?.customPatterns ?? []).join("\n");
  const maskRedactVal = maskRedact ?? masking?.redactWith ?? "[REDACTED]";
  const toggleBuiltin = (b: string) =>
    setMaskBuiltins(maskBuiltinsVal.includes(b) ? maskBuiltinsVal.filter((x) => x !== b) : [...maskBuiltinsVal, b]);
  const saveMasking = useMutation({
    mutationFn: () =>
      api.setMaskingPolicy({
        enabled: maskEnabledVal,
        builtins: maskBuiltinsVal,
        customPatterns: maskCustomVal
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        redactWith: maskRedactVal,
      }),
    onSuccess: () => {
      toast.success("Masking policy saved");
      qc.invalidateQueries({ queryKey: ["masking"] });
    },
    onError: (e) => toast.error(`Failed to save masking: ${String(e)}`),
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────
  const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);
  const { data: webhooks } = useQuery({ queryKey: ["webhooks"], queryFn: () => api.listWebhooks() });
  const webhookForm = useForm<WebhookForm>({
    resolver: zodResolver(webhookSchema),
    defaultValues: { url: "", threshold: "" },
  });
  const addWebhook = useMutation({
    mutationFn: (v: WebhookForm) =>
      api.createWebhook({
        url: v.url,
        event: "score.created",
        threshold: v.threshold === "" ? null : Number(v.threshold),
      }),
    onSuccess: (w) => {
      if (w?.secret) setNewWebhookSecret(w.secret);
      toast.success("Webhook added — copy the signing secret now");
      webhookForm.reset();
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e) => toast.error(`Failed to add webhook: ${String(e)}`),
  });
  const removeWebhook = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      toast.success("Webhook deleted");
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e) => toast.error(`Failed to delete webhook: ${String(e)}`),
  });
  const webhookColumns: ColumnDef<Webhook>[] = [
    { accessorKey: "url", header: "URL", cell: ({ row }) => <span className="font-medium">{row.original.url}</span> },
    {
      accessorKey: "event",
      header: "Event",
      cell: ({ row }) => <KindBadge tone="blue">{row.original.event}</KindBadge>,
    },
    { accessorKey: "threshold", header: "Threshold", cell: ({ row }) => row.original.threshold ?? "—" },
    {
      id: "delivery",
      header: "Last delivery",
      cell: ({ row }) => {
        const { lastStatus, lastAttemptAt, failureCount } = row.original;
        if (!lastAttemptAt) return <span className="text-muted-foreground">never fired</span>;
        const ok = lastStatus != null && lastStatus >= 200 && lastStatus < 300;
        return (
          <KindBadge tone={ok ? "green" : "red"}>
            {ok ? `OK ${lastStatus}` : `fail ${lastStatus ?? "err"}${failureCount ? ` ×${failureCount}` : ""}`}
          </KindBadge>
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <WebhookLogButton webhookId={row.original.id} url={row.original.url} />
          <Button
            variant="destructive"
            size="sm"
            disabled={readOnly || removeWebhook.isPending}
            onClick={() => removeWebhook.mutate(row.original.id)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  // ── Automations ───────────────────────────────────────────────────────────
  const { data: automations } = useQuery({ queryKey: ["automations"], queryFn: () => api.listAutomations() });
  const automationForm = useForm<AutomationForm>({
    resolver: zodResolver(automationSchema),
    defaultValues: { name: "", trigger: "score.created", action: "webhook", target: "", threshold: "", filter: "" },
  });
  const addAutomation = useMutation({
    mutationFn: (v: AutomationForm) =>
      api.createAutomation({
        name: v.name,
        trigger: v.trigger,
        action: v.action,
        target: v.target,
        threshold: v.threshold === "" ? null : Number(v.threshold),
        filter: v.filter || undefined,
      }),
    onSuccess: () => {
      toast.success("Automation added");
      automationForm.reset();
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => toast.error(`Failed to add automation: ${String(e)}`),
  });
  const removeAutomation = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => {
      toast.success("Automation deleted");
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => toast.error(`Failed to delete automation: ${String(e)}`),
  });
  const automationColumns: ColumnDef<Automation>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "trigger",
      header: "Trigger",
      cell: ({ row }) => <KindBadge tone="blue">{row.original.trigger}</KindBadge>,
    },
    {
      accessorKey: "action",
      header: "Action",
      cell: ({ row }) => <KindBadge tone="neutral">{row.original.action}</KindBadge>,
    },
    {
      accessorKey: "target",
      header: "Target",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.target}</span>,
    },
    { accessorKey: "threshold", header: "Threshold", cell: ({ row }) => row.original.threshold ?? "—" },
    {
      accessorKey: "filter",
      header: "Filter",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.filter || "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || removeAutomation.isPending}
          onClick={() => removeAutomation.mutate(row.original.id)}
        >
          Delete
        </Button>
      ),
    },
  ];

  // ── Alerts ────────────────────────────────────────────────────────────────
  const { data: alerts } = useQuery({ queryKey: ["alerts"], queryFn: () => api.listAlerts() });
  const alertForm = useForm<AlertForm>({
    resolver: zodResolver(alertSchema),
    defaultValues: {
      name: "",
      metric: "error_rate",
      comparator: "gt",
      threshold: "",
      window: "5",
      channelType: "slack",
      channelTarget: "",
    },
  });
  const addAlert = useMutation({
    mutationFn: (v: AlertForm) =>
      api.createAlert({
        name: v.name,
        metric: v.metric,
        comparator: v.comparator,
        threshold: Number(v.threshold),
        window: Number(v.window),
        channels: [{ type: v.channelType as "slack" | "webhook" | "pagerduty" | "email", target: v.channelTarget }],
      }),
    onSuccess: () => {
      toast.success("Alert rule added");
      alertForm.reset();
      qc.invalidateQueries({ queryKey: ["alerts"] });
    },
    onError: (e) => toast.error(`Failed to add alert: ${String(e)}`),
  });
  const toggleAlert = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateAlert(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
    onError: (e) => toast.error(`Failed to update alert: ${String(e)}`),
  });
  const removeAlert = useMutation({
    mutationFn: (id: string) => api.deleteAlert(id),
    onSuccess: () => {
      toast.success("Alert deleted");
      qc.invalidateQueries({ queryKey: ["alerts"] });
    },
    onError: (e) => toast.error(`Failed to delete alert: ${String(e)}`),
  });
  const alertColumns: ColumnDef<AlertRule>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "metric",
      header: "Condition",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.metric} {row.original.comparator} {row.original.threshold} · {row.original.window}m
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = row.original.status;
        return <KindBadge tone={s === "firing" ? "red" : s === "resolved" ? "amber" : "green"}>{s}</KindBadge>;
      },
    },
    {
      id: "channels",
      header: "Channels",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.channels.map((ch) => ch.type).join(", ") || "—"}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || toggleAlert.isPending}
            onClick={() => toggleAlert.mutate({ id: row.original.id, enabled: !row.original.enabled })}
          >
            {row.original.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={readOnly || removeAlert.isPending}
            onClick={() => removeAlert.mutate(row.original.id)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  // ── Cost budget ───────────────────────────────────────────────────────────
  const { data: budget } = useQuery({ queryKey: ["budget"], queryFn: () => api.getBudget() });
  const budgetForm = useForm<BudgetForm>({
    resolver: zodResolver(budgetSchema),
    defaultValues: { monthlyUsd: "", channelType: "slack", channelTarget: "" },
  });
  useEffect(() => {
    if (budget)
      budgetForm.reset({
        monthlyUsd: String(budget.monthlyUsd),
        channelType: budget.channels[0]?.type ?? "slack",
        channelTarget: budget.channels[0]?.target ?? "",
      });
  }, [budget, budgetForm]);
  const saveBudget = useMutation({
    mutationFn: (v: BudgetForm) =>
      api.setBudget({
        monthlyUsd: Number(v.monthlyUsd),
        channels: v.channelTarget
          ? [{ type: v.channelType as "slack" | "webhook" | "pagerduty" | "email", target: v.channelTarget }]
          : [],
      }),
    onSuccess: () => {
      toast.success("Budget saved");
      qc.invalidateQueries({ queryKey: ["budget"] });
    },
    onError: (e) => toast.error(`Failed to save budget: ${String(e)}`),
  });
  const removeBudget = useMutation({
    mutationFn: () => api.deleteBudget(),
    onSuccess: () => {
      toast.success("Budget removed");
      budgetForm.reset({ monthlyUsd: "", channelType: "slack", channelTarget: "" });
      qc.invalidateQueries({ queryKey: ["budget"] });
    },
    onError: (e) => toast.error(`Failed to remove budget: ${String(e)}`),
  });

  // ── Score configs ─────────────────────────────────────────────────────────
  const { data: scoreConfigs } = useQuery({ queryKey: ["score-configs"], queryFn: () => api.listScoreConfigs() });
  const scoreForm = useForm<ScoreForm>({
    resolver: zodResolver(scoreSchema),
    defaultValues: { name: "", dataType: "NUMERIC", categories: "" },
  });
  const scoreType = scoreForm.watch("dataType");
  const addScoreConfig = useMutation({
    mutationFn: (v: ScoreForm) =>
      api.createScoreConfig({
        name: v.name,
        dataType: v.dataType,
        categories:
          v.dataType === "CATEGORICAL"
            ? v.categories
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      }),
    onSuccess: () => {
      toast.success("Score config added");
      scoreForm.reset();
      qc.invalidateQueries({ queryKey: ["score-configs"] });
    },
    onError: (e) => toast.error(`Failed to add score: ${String(e)}`),
  });
  const removeScoreConfig = useMutation({
    mutationFn: (id: string) => api.deleteScoreConfig(id),
    onSuccess: () => {
      toast.success("Score config deleted");
      qc.invalidateQueries({ queryKey: ["score-configs"] });
    },
    onError: (e) => toast.error(`Failed to delete score: ${String(e)}`),
  });
  const scoreColumns: ColumnDef<ScoreConfig>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "dataType",
      header: "Type",
      cell: ({ row }) => <KindBadge tone="neutral">{row.original.dataType.toLowerCase()}</KindBadge>,
    },
    {
      accessorKey: "categories",
      header: "Categories",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.categories.join(", ") || "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || removeScoreConfig.isPending}
          onClick={() => removeScoreConfig.mutate(row.original.id)}
        >
          Delete
        </Button>
      ),
    },
  ];

  // ── Model pricing ─────────────────────────────────────────────────────────
  const { data: modelPrices } = useQuery({ queryKey: ["model-prices"], queryFn: () => api.listModelPrices() });
  const pricingForm = useForm<PricingForm>({
    resolver: zodResolver(pricingSchema),
    defaultValues: { pattern: "", provider: "", inputPerMTok: "", outputPerMTok: "" },
  });
  const addModelPrice = useMutation({
    mutationFn: (v: PricingForm) =>
      api.createModelPrice({
        pattern: v.pattern,
        provider: v.provider || undefined,
        inputPerMTok: Number(v.inputPerMTok),
        outputPerMTok: Number(v.outputPerMTok),
      }),
    onSuccess: () => {
      toast.success("Model price added");
      pricingForm.reset();
      qc.invalidateQueries({ queryKey: ["model-prices"] });
    },
    onError: (e) => toast.error(`Failed to add price: ${String(e)}`),
  });
  const removeModelPrice = useMutation({
    mutationFn: (id: string) => api.deleteModelPrice(id),
    onSuccess: () => {
      toast.success("Model price deleted");
      qc.invalidateQueries({ queryKey: ["model-prices"] });
    },
    onError: (e) => toast.error(`Failed to delete price: ${String(e)}`),
  });
  const modelPriceColumns: ColumnDef<ModelPrice>[] = [
    {
      accessorKey: "pattern",
      header: "Pattern",
      cell: ({ row }) => <code className="text-xs">{row.original.pattern}</code>,
    },
    {
      accessorKey: "provider",
      header: "Provider",
      cell: ({ row }) =>
        row.original.provider ? (
          <span className="inline-flex items-center gap-1.5">
            <ProviderIcon provider={row.original.provider} size={15} />
            {row.original.provider}
          </span>
        ) : (
          "—"
        ),
    },
    { accessorKey: "inputPerMTok", header: "Input / 1M", cell: ({ row }) => `$${row.original.inputPerMTok}` },
    { accessorKey: "outputPerMTok", header: "Output / 1M", cell: ({ row }) => `$${row.original.outputPerMTok}` },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="destructive"
          size="sm"
          disabled={readOnly || removeModelPrice.isPending}
          onClick={() => removeModelPrice.mutate(row.original.id)}
        >
          Delete
        </Button>
      ),
    },
  ];
  const builtinColumns: ColumnDef<ModelPriceBuiltin>[] = [
    {
      accessorKey: "pattern",
      header: "Pattern",
      cell: ({ row }) => <code className="text-xs">{row.original.pattern}</code>,
    },
    {
      accessorKey: "provider",
      header: "Provider",
      cell: ({ row }) =>
        row.original.provider ? (
          <span className="inline-flex items-center gap-1.5">
            <ProviderIcon provider={row.original.provider} size={15} />
            {row.original.provider}
          </span>
        ) : (
          "—"
        ),
    },
    { accessorKey: "inputPerMTok", header: "Input / 1M", cell: ({ row }) => `$${row.original.inputPerMTok}` },
    { accessorKey: "outputPerMTok", header: "Output / 1M", cell: ({ row }) => `$${row.original.outputPerMTok}` },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Project configuration: keys, providers, retention, automations, and pricing."
      />

      <Tabs defaultValue="api-keys">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="api-keys">API Keys</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="retention">Data Retention</TabsTrigger>
          <TabsTrigger value="exports">Exports &amp; Analytics</TabsTrigger>
          <TabsTrigger value="masking">Masking</TabsTrigger>
          <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="scores">Scores</TabsTrigger>
          <TabsTrigger value="pricing">Model Pricing</TabsTrigger>
        </TabsList>

        {/* ── Access (per-project RBAC) ─────────────────────────────────── */}
        <TabsContent value="access" className="space-y-6">
          <ProjectAccess />
        </TabsContent>

        {/* ── Guardrails (runtime PII / injection / blocked terms) ──────── */}
        <TabsContent value="guardrails" className="space-y-6">
          <ProjectGuardrails />
        </TabsContent>

        {/* ── Security (per-user: 2FA + passkeys) ───────────────────────── */}
        <TabsContent value="security" className="space-y-6">
          <AccountSecurity />
        </TabsContent>

        {/* ── API Keys ──────────────────────────────────────────────────── */}
        <TabsContent value="api-keys" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Create API key</CardTitle>
              <CardDescription>
                Project-scoped keys for the SDK / ingestion API (Basic auth: <code>publicKey:secretKey</code>). The
                secret is shown once at creation — store it now; it can&apos;t be retrieved later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...apiKeyForm}>
                <form
                  onSubmit={apiKeyForm.handleSubmit((v) =>
                    createKey.mutate({
                      name: v.name || undefined,
                      scopes: v.scopes,
                      expiresInDays: v.expiresInDays ? Number(v.expiresInDays) : null,
                      rateLimitPerMinute: v.rateLimitPerMinute ? Number(v.rateLimitPerMinute) : null,
                    }),
                  )}
                  className="space-y-4"
                >
                  <div className="grid gap-4 sm:grid-cols-3">
                    <FormField
                      control={apiKeyForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Name</FormLabel>
                          <FormControl>
                            <Input placeholder="key name (optional)" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={apiKeyForm.control}
                      name="expiresInDays"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Expires (days)</FormLabel>
                          <FormControl>
                            <Input type="number" min="1" placeholder="never" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={apiKeyForm.control}
                      name="rateLimitPerMinute"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Rate / min</FormLabel>
                          <FormControl>
                            <Input type="number" min="1" placeholder="unlimited" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={apiKeyForm.control}
                    name="scopes"
                    render={() => (
                      <FormItem>
                        <FormLabel>Scopes</FormLabel>
                        <div className="flex flex-wrap gap-4">
                          {["read", "write", "ingest"].map((s) => (
                            <FormField
                              key={s}
                              control={apiKeyForm.control}
                              name="scopes"
                              render={({ field }) => (
                                <FormItem className="flex flex-row items-center gap-2 space-y-0">
                                  <FormControl>
                                    <Checkbox
                                      checked={field.value?.includes(s)}
                                      onCheckedChange={(c) =>
                                        c
                                          ? field.onChange([...field.value, s])
                                          : field.onChange(field.value.filter((x: string) => x !== s))
                                      }
                                    />
                                  </FormControl>
                                  <FormLabel className="font-normal">{s}</FormLabel>
                                </FormItem>
                              )}
                            />
                          ))}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={readOnly || createKey.isPending}>
                    {createKey.isPending ? "Creating…" : "Create key"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {newSecret && (
            <Card className="border-emerald-500/40">
              <CardHeader>
                <CardTitle className="text-base">New key — copy the secret now, it won&apos;t be shown again</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs">{`publicKey: ${newSecret.publicKey}\nsecretKey: ${newSecret.secretKey}`}</pre>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(`${newSecret.publicKey}:${newSecret.secretKey}`);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <Copy className="size-4" /> Copy
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setNewSecret(null)}>
                    Dismiss
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {!apiKeys || apiKeys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create one above to use the SDK or ingestion API."
            />
          ) : (
            <DataTable columns={apiKeyColumns} data={apiKeys} />
          )}
        </TabsContent>

        {/* ── Providers ─────────────────────────────────────────────────── */}
        <TabsContent value="providers" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>LLM provider connections</CardTitle>
              <CardDescription>
                API keys are encrypted at rest and used by the playground + evaluators. The &quot;mock&quot; provider
                needs no key.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...providerForm}>
                <form
                  onSubmit={providerForm.handleSubmit((v) => saveProvider.mutate(v))}
                  className="flex flex-wrap items-end gap-4"
                >
                  <FormField
                    control={providerForm.control}
                    name="provider"
                    render={({ field }) => (
                      <FormItem className="w-40">
                        <FormLabel>Provider</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
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
                    control={providerForm.control}
                    name="apiKey"
                    render={({ field }) => (
                      <FormItem className="flex-1 min-w-[260px]">
                        <FormLabel>API key{providerKind === "openai_compatible" ? " (optional)" : ""}</FormLabel>
                        <FormControl>
                          <Input type="password" placeholder="API key" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {(providerKind === "openai_compatible" || providerKind === "azure") && (
                    <FormField
                      control={providerForm.control}
                      name="baseUrl"
                      render={({ field }) => (
                        <FormItem className="flex-1 min-w-[260px]">
                          <FormLabel>Base URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://…/v1" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  {providerKind === "bedrock" && (
                    <FormField
                      control={providerForm.control}
                      name="region"
                      render={({ field }) => (
                        <FormItem className="w-40">
                          <FormLabel>Region</FormLabel>
                          <FormControl>
                            <Input placeholder="us-east-1" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  <Button type="submit" disabled={readOnly || saveProvider.isPending}>
                    {saveProvider.isPending ? "Saving…" : "Save key"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {!providers || providers.length === 0 ? (
            <EmptyState icon={Plug} title="No provider keys configured" description="Add a provider key above." />
          ) : (
            <DataTable
              columns={[
                {
                  accessorKey: "provider",
                  header: "Provider",
                  cell: ({ row }) => (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <ProviderIcon provider={row.original.provider} size={16} />
                      {row.original.provider}
                    </span>
                  ),
                },
                {
                  accessorKey: "masked",
                  header: "Key",
                  cell: ({ row }) => <span className="text-muted-foreground">{row.original.masked}</span>,
                },
                {
                  accessorKey: "createdAt",
                  header: "Added",
                  cell: ({ row }) => (
                    <span className="text-muted-foreground">
                      {row.original.createdAt.slice(0, 19).replace("T", " ")}
                    </span>
                  ),
                },
              ]}
              data={providers}
            />
          )}
        </TabsContent>

        {/* ── Data Retention ────────────────────────────────────────────── */}
        <TabsContent value="retention" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Data retention</CardTitle>
              <CardDescription>
                Delete traces/observations/scores older than N days (0 = keep forever). A daily worker job enforces
                this.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="retention-days">Days</Label>
                  <Input
                    id="retention-days"
                    type="number"
                    min="0"
                    className="w-32"
                    value={daysValue}
                    onChange={(e) => setDays(Number(e.target.value))}
                  />
                </div>
                <Button disabled={readOnly || saveRetention.isPending} onClick={() => saveRetention.mutate()}>
                  {saveRetention.isPending ? "Saving…" : "Save retention"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ingest sampling</CardTitle>
              <CardDescription>
                Keep only this percent of traces in the query store (100 = keep all). Dropped traces still land in blob
                storage and stay replayable — this trims what's queryable to control volume, it doesn't lose data. The
                decision is stable per trace, so whole traces are kept or dropped.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="sampling-rate">Keep %</Label>
                  <Input
                    id="sampling-rate"
                    type="number"
                    min="0"
                    max="100"
                    className="w-32"
                    value={rateValue}
                    onChange={(e) => setRate(Number(e.target.value))}
                  />
                </div>
                <Button disabled={readOnly || saveSampling.isPending} onClick={() => saveSampling.mutate()}>
                  {saveSampling.isPending ? "Saving…" : "Save sampling"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Exports & Analytics ───────────────────────────────────────── */}
        <TabsContent value="exports" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Scheduled exports</CardTitle>
              <CardDescription>
                When enabled, a daily worker job writes the project&apos;s traces (NDJSON) to blob storage under{" "}
                <code>exports/&lt;projectId&gt;/&lt;date&gt;/</code>. Use &quot;Run now&quot; to export immediately.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="se-enabled"
                  checked={seEnabledValue}
                  onCheckedChange={(c) => setSeEnabled(c === true)}
                  disabled={readOnly}
                />
                <Label htmlFor="se-enabled" className="font-normal">
                  enabled
                </Label>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="se-env">Environment (optional)</Label>
                  <Input id="se-env" className="w-48" value={seEnvValue} onChange={(e) => setSeEnv(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="se-limit">Max traces</Label>
                  <Input
                    id="se-limit"
                    type="number"
                    min="1"
                    className="w-32"
                    value={seLimitValue}
                    onChange={(e) => setSeLimit(Number(e.target.value))}
                  />
                </div>
                <Button disabled={readOnly || saveSchedExport.isPending} onClick={() => saveSchedExport.mutate()}>
                  {saveSchedExport.isPending ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outline"
                  disabled={readOnly || runSchedExport.isPending}
                  onClick={() => runSchedExport.mutate()}
                >
                  {runSchedExport.isPending ? "Exporting…" : "Run now"}
                </Button>
              </div>
              {schedExport?.lastRunAt && (
                <p className="text-sm text-muted-foreground">
                  Last run {schedExport.lastRunAt.slice(0, 19).replace("T", " ")} — {schedExport.lastCount} traces →{" "}
                  <code>{schedExport.lastKey}</code>
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Event sink (CDP forwarding)</CardTitle>
              <CardDescription>
                When enabled, the worker forwards <code>trace.created</code> and <code>score.created</code> events to
                your product-analytics/CDP endpoint (PostHog-compatible capture API — also accepted by Segment, Jitsu,
                and self-hosted PostHog) so you can build funnels/retention over LLM usage.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="an-enabled"
                  checked={anEnabledValue}
                  onCheckedChange={(c) => setAnEnabled(c === true)}
                  disabled={readOnly}
                />
                <Label htmlFor="an-enabled" className="font-normal">
                  enabled
                </Label>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="an-host">Host</Label>
                  <Input
                    id="an-host"
                    className="w-64"
                    value={anHostValue}
                    onChange={(e) => setAnHost(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="an-key">API key</Label>
                  <Input
                    id="an-key"
                    type="password"
                    className="w-64"
                    placeholder={analytics?.apiKey ? "API key (set — leave blank to keep)" : "Capture API key"}
                    value={anKey}
                    onChange={(e) => setAnKey(e.target.value)}
                  />
                </div>
                <Button disabled={readOnly || saveAnalytics.isPending} onClick={() => saveAnalytics.mutate()}>
                  {saveAnalytics.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Masking ───────────────────────────────────────────────────── */}
        <TabsContent value="masking" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>PII masking</CardTitle>
              <CardDescription>
                When enabled, the worker redacts matches from trace/observation input/output (and metadata) at ingest,
                before they&apos;re stored. Built-in patterns plus your own regexes (one per line).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="mask-enabled"
                  checked={maskEnabledVal}
                  onCheckedChange={(c) => setMaskEnabled(c === true)}
                  disabled={readOnly}
                />
                <Label htmlFor="mask-enabled" className="font-normal">
                  enabled
                </Label>
              </div>
              <div className="space-y-2">
                <Label>Built-in patterns</Label>
                <div className="flex flex-wrap gap-4">
                  {(masking?.available ?? []).map((b) => (
                    <div key={b} className="flex items-center gap-2">
                      <Checkbox
                        id={`mask-${b}`}
                        checked={maskBuiltinsVal.includes(b)}
                        onCheckedChange={() => toggleBuiltin(b)}
                        disabled={readOnly}
                      />
                      <Label htmlFor={`mask-${b}`} className="font-normal">
                        {b}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mask-redact">Redact with</Label>
                <Input
                  id="mask-redact"
                  className="w-48"
                  value={maskRedactVal}
                  onChange={(e) => setMaskRedact(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mask-custom">Custom patterns</Label>
                <Textarea
                  id="mask-custom"
                  rows={3}
                  placeholder="custom regex patterns, one per line (e.g. sk-[a-z0-9]+)"
                  value={maskCustomVal}
                  onChange={(e) => setMaskCustom(e.target.value)}
                />
              </div>
              <Button disabled={readOnly || saveMasking.isPending} onClick={() => saveMasking.mutate()}>
                {saveMasking.isPending ? "Saving…" : "Save masking"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Webhooks ──────────────────────────────────────────────────── */}
        <TabsContent value="webhooks" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Webhooks</CardTitle>
              <CardDescription>
                POST to a URL when a score is created. Set a threshold to only fire on low scores (value &lt;
                threshold).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...webhookForm}>
                <form
                  onSubmit={webhookForm.handleSubmit((v) => addWebhook.mutate(v))}
                  className="flex flex-wrap items-end gap-4"
                >
                  <FormField
                    control={webhookForm.control}
                    name="url"
                    render={({ field }) => (
                      <FormItem className="flex-1 min-w-[300px]">
                        <FormLabel>URL</FormLabel>
                        <FormControl>
                          <Input placeholder="https://…" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={webhookForm.control}
                    name="threshold"
                    render={({ field }) => (
                      <FormItem className="w-40">
                        <FormLabel>Threshold</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.1" placeholder="optional" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={readOnly || addWebhook.isPending}>
                    {addWebhook.isPending ? "Saving…" : "Add webhook"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {newWebhookSecret && (
            <Card className="border-emerald-500/40">
              <CardHeader>
                <CardTitle className="text-base">Signing secret — copy it now, it won&apos;t be shown again</CardTitle>
                <CardDescription>
                  Verify deliveries: the <code>X-Memoturn-Signature</code> header is <code>sha256=</code> + HMAC-SHA256
                  of <code>timestamp.body</code> keyed by this secret, where <code>timestamp</code> is the{" "}
                  <code>X-Memoturn-Timestamp</code> header and <code>body</code> is the raw request body.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-xs">{newWebhookSecret}</pre>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(newWebhookSecret);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <Copy className="size-4" /> Copy
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setNewWebhookSecret(null)}>
                    Dismiss
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {!webhooks || webhooks.length === 0 ? (
            <EmptyState
              icon={WebhookIcon}
              title="No webhooks yet"
              description="Add one above to receive score events."
            />
          ) : (
            <DataTable columns={webhookColumns} data={webhooks} />
          )}
        </TabsContent>

        {/* ── Automations ───────────────────────────────────────────────── */}
        <TabsContent value="automations" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Automations</CardTitle>
              <CardDescription>
                Run an action when a trigger fires. Triggers: score.created, trace.created, eval.completed. Actions: a
                generic webhook (POST JSON) or a Slack message (to an incoming-webhook URL). Threshold fires only on low
                scores; filter is a substring match on the entity name.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...automationForm}>
                <form onSubmit={automationForm.handleSubmit((v) => addAutomation.mutate(v))} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <FormField
                      control={automationForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Name</FormLabel>
                          <FormControl>
                            <Input placeholder="name" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={automationForm.control}
                      name="trigger"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Trigger</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="score.created">score.created</SelectItem>
                              <SelectItem value="trace.created">trace.created</SelectItem>
                              <SelectItem value="eval.completed">eval.completed</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={automationForm.control}
                      name="action"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Action</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="webhook">webhook</SelectItem>
                              <SelectItem value="slack">slack</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={automationForm.control}
                      name="target"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Target URL</FormLabel>
                          <FormControl>
                            <Input placeholder="target URL" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={automationForm.control}
                      name="threshold"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Threshold</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" placeholder="optional" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={automationForm.control}
                      name="filter"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Filter</FormLabel>
                          <FormControl>
                            <Input placeholder="optional" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <Button type="submit" disabled={readOnly || addAutomation.isPending}>
                    {addAutomation.isPending ? "Saving…" : "Add automation"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {!automations || automations.length === 0 ? (
            <EmptyState icon={Zap} title="No automations yet" description="Add one above to react to score events." />
          ) : (
            <DataTable columns={automationColumns} data={automations} />
          )}
        </TabsContent>

        {/* ── Alerts ────────────────────────────────────────────────────── */}
        <TabsContent value="alerts" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Alert rules</CardTitle>
              <CardDescription>
                A worker cron evaluates each rule every minute over a trailing window and notifies your channels when it
                crosses the threshold — firing once, then again when it resolves. Metrics: error_rate (0–1), latency_p95
                (ms), cost_per_day (USD), ingest_volume (traces), dlq_depth (failed batches).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...alertForm}>
                <form onSubmit={alertForm.handleSubmit((v) => addAlert.mutate(v))} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <FormField
                      control={alertForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Name</FormLabel>
                          <FormControl>
                            <Input placeholder="High error rate" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="metric"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Metric</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="error_rate">error_rate</SelectItem>
                              <SelectItem value="latency_p95">latency_p95</SelectItem>
                              <SelectItem value="cost_per_day">cost_per_day</SelectItem>
                              <SelectItem value="ingest_volume">ingest_volume</SelectItem>
                              <SelectItem value="dlq_depth">dlq_depth</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="comparator"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Comparator</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="gt">&gt;</SelectItem>
                              <SelectItem value="gte">&ge;</SelectItem>
                              <SelectItem value="lt">&lt;</SelectItem>
                              <SelectItem value="lte">&le;</SelectItem>
                              <SelectItem value="anomaly_high">anomaly ↑ (spike, σ)</SelectItem>
                              <SelectItem value="anomaly_low">anomaly ↓ (drop, σ)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="threshold"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Threshold</FormLabel>
                          <FormControl>
                            <Input type="number" step="any" placeholder="0.05" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="window"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Window (minutes)</FormLabel>
                          <FormControl>
                            <Input type="number" step="1" placeholder="5" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="channelType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Channel</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="slack">slack</SelectItem>
                              <SelectItem value="webhook">webhook</SelectItem>
                              <SelectItem value="pagerduty">pagerduty</SelectItem>
                              <SelectItem value="email">email</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={alertForm.control}
                      name="channelTarget"
                      render={({ field }) => (
                        <FormItem className="lg:col-span-2">
                          <FormLabel>Channel target</FormLabel>
                          <FormControl>
                            <Input placeholder="URL (slack/webhook), routing key (pagerduty), or email" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <Button type="submit" disabled={readOnly || addAlert.isPending}>
                    {addAlert.isPending ? "Saving…" : "Add alert rule"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {!alerts || alerts.length === 0 ? (
            <EmptyState icon={BellRing} title="No alert rules yet" description="Add one above to watch production." />
          ) : (
            <DataTable columns={alertColumns} data={alerts} />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Monthly cost budget</CardTitle>
              <CardDescription>
                Get notified as month-to-date spend crosses 50% / 80% / 100% of this budget. Soft only — memoturn never
                caps or blocks traffic.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...budgetForm}>
                <form onSubmit={budgetForm.handleSubmit((v) => saveBudget.mutate(v))} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <FormField
                      control={budgetForm.control}
                      name="monthlyUsd"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Monthly budget (USD)</FormLabel>
                          <FormControl>
                            <Input type="number" step="any" placeholder="500" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={budgetForm.control}
                      name="channelType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Channel</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="slack">slack</SelectItem>
                              <SelectItem value="webhook">webhook</SelectItem>
                              <SelectItem value="pagerduty">pagerduty</SelectItem>
                              <SelectItem value="email">email</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={budgetForm.control}
                      name="channelTarget"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Channel target</FormLabel>
                          <FormControl>
                            <Input placeholder="URL (slack/webhook), routing key (pagerduty), or email" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={readOnly || saveBudget.isPending}>
                      {saveBudget.isPending ? "Saving…" : "Save budget"}
                    </Button>
                    {budget && (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={readOnly || removeBudget.isPending}
                        onClick={() => removeBudget.mutate()}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Scores ────────────────────────────────────────────────────── */}
        <TabsContent value="scores" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Score configs</CardTitle>
              <CardDescription>
                Define the scores used for this project. Categorical configs drive the review form (dropdown of
                categories).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...scoreForm}>
                <form
                  onSubmit={scoreForm.handleSubmit((v) => addScoreConfig.mutate(v))}
                  className="flex flex-wrap items-end gap-4"
                >
                  <FormField
                    control={scoreForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem className="w-48">
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input placeholder="score name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={scoreForm.control}
                    name="dataType"
                    render={({ field }) => (
                      <FormItem className="w-40">
                        <FormLabel>Type</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="NUMERIC">numeric</SelectItem>
                            <SelectItem value="CATEGORICAL">categorical</SelectItem>
                            <SelectItem value="BOOLEAN">boolean</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {scoreType === "CATEGORICAL" && (
                    <FormField
                      control={scoreForm.control}
                      name="categories"
                      render={({ field }) => (
                        <FormItem className="w-64">
                          <FormLabel>Categories</FormLabel>
                          <FormControl>
                            <Input placeholder="comma-separated" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  <Button type="submit" disabled={readOnly || addScoreConfig.isPending}>
                    {addScoreConfig.isPending ? "Saving…" : "Add score"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {!scoreConfigs || scoreConfigs.length === 0 ? (
            <EmptyState icon={ListChecks} title="No score configs yet" description="Define a score above." />
          ) : (
            <DataTable columns={scoreColumns} data={scoreConfigs} />
          )}
        </TabsContent>

        {/* ── Model Pricing ─────────────────────────────────────────────── */}
        <TabsContent value="pricing" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Model pricing</CardTitle>
              <CardDescription>
                Override token prices (USD per 1M tokens) for models matched by a name pattern (a case-insensitive
                regex, e.g. <code>^my-model</code>). Overrides take precedence over the built-in defaults and apply to
                newly ingested generations.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...pricingForm}>
                <form
                  onSubmit={pricingForm.handleSubmit((v) => addModelPrice.mutate(v))}
                  className="flex flex-wrap items-end gap-4"
                >
                  <FormField
                    control={pricingForm.control}
                    name="pattern"
                    render={({ field }) => (
                      <FormItem className="w-56">
                        <FormLabel>Pattern</FormLabel>
                        <FormControl>
                          <Input placeholder="^my-model" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={pricingForm.control}
                    name="provider"
                    render={({ field }) => (
                      <FormItem className="w-40">
                        <FormLabel>Provider</FormLabel>
                        <FormControl>
                          <Input placeholder="optional" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={pricingForm.control}
                    name="inputPerMTok"
                    render={({ field }) => (
                      <FormItem className="w-32">
                        <FormLabel>Input / 1M</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="0" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={pricingForm.control}
                    name="outputPerMTok"
                    render={({ field }) => (
                      <FormItem className="w-32">
                        <FormLabel>Output / 1M</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="0" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={readOnly || addModelPrice.isPending}>
                    {addModelPrice.isPending ? "Saving…" : "Add price"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          {!modelPrices || modelPrices.data.length === 0 ? (
            <EmptyState
              icon={DollarSign}
              title="No price overrides"
              description="Add one above to override built-in pricing."
            />
          ) : (
            <DataTable columns={modelPriceColumns} data={modelPrices.data} />
          )}

          {modelPrices && modelPrices.builtins.length > 0 && (
            <Collapsible className="space-y-3">
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm">
                  Built-in defaults ({modelPrices.builtins.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <DataTable columns={builtinColumns} data={modelPrices.builtins} pageSize={50} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
