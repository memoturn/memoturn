import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { KindBadge } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api, type ExperimentSummary } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";

export const Route = createFileRoute("/experiments/")({
  component: ExperimentsPage,
  validateSearch: (s: Record<string, unknown>): { dataset?: string } => ({
    dataset: typeof s.dataset === "string" ? s.dataset : undefined,
  }),
});

const statusTone: Record<string, "green" | "blue" | "red" | "neutral" | "amber"> = {
  COMPLETED: "green",
  RUNNING: "blue",
  PENDING: "neutral",
  FAILED: "red",
  CANCELLED: "amber",
};

function ExperimentsPage() {
  const { dataset } = Route.useSearch();
  const readOnly = useIsReadOnly();
  const { data: experiments } = useQuery({
    queryKey: ["experiments"],
    queryFn: () => api.listExperiments(),
    // Poll while any experiment is in flight so progress advances live — including
    // when the tab is backgrounded (start a run, tab away, come back to see it done).
    refetchInterval: (q) =>
      (q.state.data ?? []).some((e: ExperimentSummary) => e.status === "RUNNING" || e.status === "PENDING")
        ? 2000
        : false,
    refetchIntervalInBackground: true,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experiments"
        description="Run a prompt/model across a dataset and auto-score every item."
        actions={!readOnly ? <NewExperimentDialog defaultDataset={dataset} /> : undefined}
      />

      <Card>
        <CardHeader>
          <CardTitle>All experiments</CardTitle>
        </CardHeader>
        <CardContent className={!experiments || experiments.length === 0 ? undefined : "px-0"}>
          {!experiments || experiments.length === 0 ? (
            <EmptyState title="No experiments yet" description="Create one to run a dataset through a model." />
          ) : (
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Dataset</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {experiments.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <Link
                          to="/experiments/$id"
                          params={{ id: e.id }}
                          className="font-medium text-primary hover:underline"
                        >
                          {e.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{e.dataset}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {e.provider}/{e.model}
                      </TableCell>
                      <TableCell>
                        <KindBadge tone={statusTone[e.status] ?? "neutral"}>{e.status}</KindBadge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {e.completedItems + e.failedItems}/{e.totalItems}
                        {e.failedItems > 0 && <span className="ml-1 text-destructive">({e.failedItems} failed)</span>}
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

function NewExperimentDialog({ defaultDataset }: { defaultDataset?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(!!defaultDataset);

  const [datasetName, setDatasetName] = useState(defaultDataset ?? "");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-gpt-4o");
  const [temperature, setTemperature] = useState("");
  const [promptName, setPromptName] = useState("");
  const [selectedEvals, setSelectedEvals] = useState<string[]>([]);

  const { data: datasets } = useQuery({ queryKey: ["datasets"], queryFn: () => api.listDatasets() });
  const { data: evaluators } = useQuery({ queryKey: ["evaluators"], queryFn: () => api.listEvaluators() });
  const { data: templates } = useQuery({
    queryKey: ["evaluator-templates"],
    queryFn: () => api.listEvaluatorTemplates(),
  });

  const instantiate = useMutation({
    mutationFn: (key: string) => api.instantiateEvaluatorTemplate({ key }),
    onSuccess: (ev) => {
      toast.success(`Added evaluator "${ev.name}"`);
      qc.invalidateQueries({ queryKey: ["evaluators"] });
      setSelectedEvals((s) => (s.includes(ev.name) ? s : [...s, ev.name]));
    },
    onError: (e) => toast.error(String(e)),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createExperiment({
        datasetName,
        name,
        provider,
        model,
        params: temperature ? { temperature: Number(temperature) } : undefined,
        promptName: promptName || undefined,
        evaluators: selectedEvals,
      }),
    onSuccess: (exp) => {
      toast.success(`Experiment "${exp.name}" queued`);
      qc.invalidateQueries({ queryKey: ["experiments"] });
      setOpen(false);
      navigate({ to: "/experiments/$id", params: { id: exp.id } });
    },
    onError: (e) => toast.error(String(e)),
  });

  const toggleEval = (n: string) => setSelectedEvals((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 size-4" /> New experiment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New experiment</DialogTitle>
          <DialogDescription>
            Runs every item in the dataset through the chosen model, then scores it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Dataset</Label>
            <Select value={datasetName} onValueChange={setDatasetName}>
              <SelectTrigger>
                <SelectValue placeholder="Select a dataset" />
              </SelectTrigger>
              <SelectContent>
                {(datasets ?? []).map((d) => (
                  <SelectItem key={d.name} value={d.name}>
                    {d.name} ({d.items} items)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-name">Experiment name</Label>
            <Input id="exp-name" placeholder="gpt-4o-baseline" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">mock</SelectItem>
                  <SelectItem value="anthropic">anthropic</SelectItem>
                  <SelectItem value="openai">openai</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-model">Model</Label>
              <Input id="exp-model" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-temp">Temperature (optional)</Label>
              <Input
                id="exp-temp"
                placeholder="0.0"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-prompt">Prompt name (optional)</Label>
              <Input
                id="exp-prompt"
                placeholder="raw item input"
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Evaluators</Label>
            {(evaluators ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No evaluators yet — add one from the library below.</p>
            )}
            <div className="space-y-1.5">
              {(evaluators ?? []).map((ev) => (
                <div key={ev.name} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`eval-${ev.name}`}
                    checked={selectedEvals.includes(ev.name)}
                    onCheckedChange={() => toggleEval(ev.name)}
                  />
                  <Label htmlFor={`eval-${ev.name}`} className="font-normal">
                    {ev.name}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {ev.provider}/{ev.model}
                  </span>
                </div>
              ))}
            </div>
            {templates && templates.length > 0 && (
              <div className="rounded-md border p-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Sparkles className="size-3.5" /> Prebuilt library
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {templates.map((t) => (
                    <Button
                      key={t.key}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={instantiate.isPending || (evaluators ?? []).some((e) => e.name === t.name)}
                      title={t.description}
                      onClick={() => instantiate.mutate(t.key)}
                    >
                      + {t.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!datasetName || !name || !model || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Queuing…" : "Run experiment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
