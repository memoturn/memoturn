import { computeCost } from "@memoturn/core/models";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Play, Plus, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { api, type PlaygroundResponse, streamPlayground } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/playground")({ component: PlaygroundPage });

type Mode = "chat" | "structured" | "tools";
type Column = { id: number; provider: string; model: string; temperature: number };
type ColState = { streamed: string; result: PlaygroundResponse | null; error: string | null; busy: boolean };

const MAX_COLUMNS = 4;
const EMPTY_COL: ColState = { streamed: "", result: null, error: null, busy: false };
const defaultModel = (p: string) => (p === "anthropic" ? "claude-sonnet-5" : p === "openai" ? "gpt-4o-mini" : "mock-1");

function fmtCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.01) return `$${c.toFixed(5)}`;
  return `$${c.toFixed(4)}`;
}

function PlaygroundPage() {
  const readOnly = useIsReadOnly();
  // Shared prompt drives every column.
  const [system, setSystem] = useState("You are a helpful assistant.");
  const [userMsg, setUserMsg] = useState("Explain what memoturn is in one sentence.");
  const [mode, setMode] = useState<Mode>("chat");
  const [schemaText, setSchemaText] = useState(
    JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, null, 2),
  );
  const [toolsText, setToolsText] = useState(
    JSON.stringify(
      [
        {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      null,
      2,
    ),
  );
  const [streaming, setStreaming] = useState(true);

  const [columns, setColumns] = useState<Column[]>([{ id: 1, provider: "mock", model: "mock-1", temperature: 0.2 }]);
  const [colState, setColState] = useState<Record<number, ColState>>({});
  const [nextId, setNextId] = useState(2);
  const anyBusy = Object.values(colState).some((s) => s.busy);

  // Seed the shared prompt from a trace ("Open in Playground").
  useEffect(() => {
    try {
      const raw = localStorage.getItem("memoturn.playground.seed");
      if (!raw) return;
      localStorage.removeItem("memoturn.playground.seed");
      const seed = JSON.parse(raw) as { provider?: string; model?: string; system?: string; userMsg?: string };
      if (typeof seed.system === "string" && seed.system) setSystem(seed.system);
      if (typeof seed.userMsg === "string") setUserMsg(seed.userMsg);
      if (seed.provider || seed.model) {
        setColumns((cols) =>
          cols.map((c, i) =>
            i === 0 ? { ...c, provider: seed.provider ?? c.provider, model: seed.model ?? c.model } : c,
          ),
        );
      }
    } catch {
      /* ignore malformed seed */
    }
  }, []);

  function updateColumn(id: number, patch: Partial<Column>) {
    setColumns((cols) => cols.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function addColumn() {
    if (columns.length >= MAX_COLUMNS) return;
    const base = columns[columns.length - 1] ?? { provider: "mock", model: "mock-1", temperature: 0.2 };
    setColumns((cols) => [
      ...cols,
      { id: nextId, provider: base.provider, model: base.model, temperature: base.temperature },
    ]);
    setNextId((n) => n + 1);
  }
  function removeColumn(id: number) {
    setColumns((cols) => (cols.length <= 1 ? cols : cols.filter((c) => c.id !== id)));
    setColState((s) => {
      const { [id]: _drop, ...rest } = s;
      return rest;
    });
  }

  const sharedMessages = () => [
    { role: "system" as const, content: system },
    { role: "user" as const, content: userMsg },
  ];

  async function runAll() {
    let responseFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined;
    let tools: unknown;
    try {
      responseFormat = mode === "structured" ? { type: "json_schema", schema: JSON.parse(schemaText) } : undefined;
      tools = mode === "tools" ? JSON.parse(toolsText) : undefined;
    } catch (e) {
      toast.error(`Invalid JSON: ${e}`);
      return;
    }
    const messages = sharedMessages();
    setColState(
      Object.fromEntries(columns.map((c) => [c.id, { streamed: "", result: null, error: null, busy: true }])),
    );

    await Promise.allSettled(
      columns.map(async (col) => {
        try {
          if (mode === "chat" && streaming) {
            await streamPlayground(
              { provider: col.provider, model: col.model, temperature: col.temperature, messages },
              (delta) =>
                setColState((s) => ({
                  ...s,
                  [col.id]: { ...(s[col.id] ?? EMPTY_COL), streamed: (s[col.id]?.streamed ?? "") + delta },
                })),
            );
            setColState((s) => ({ ...s, [col.id]: { ...(s[col.id] ?? EMPTY_COL), busy: false } }));
          } else {
            const r = await api.playgroundChat({
              provider: col.provider,
              model: col.model,
              temperature: col.temperature,
              messages,
              tools: tools as never,
              responseFormat,
            });
            setColState((s) => ({ ...s, [col.id]: { ...(s[col.id] ?? EMPTY_COL), result: r, busy: false } }));
          }
        } catch (e) {
          setColState((s) => ({ ...s, [col.id]: { ...(s[col.id] ?? EMPTY_COL), error: String(e), busy: false } }));
        }
      }),
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Playground"
        description="Compare a prompt across models side by side."
        actions={
          !readOnly ? (
            <SaveAsExperimentDialog columns={columns} messages={sharedMessages} disabled={anyBusy} />
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Shared prompt</CardTitle>
          <CardDescription>One prompt, run against every column.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Mode</Label>
              <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <TabsList className="w-full">
                  <TabsTrigger value="chat">chat</TabsTrigger>
                  <TabsTrigger value="structured">structured</TabsTrigger>
                  <TabsTrigger value="tools">tools</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex items-end gap-2">
              <Switch id="pg-stream" checked={streaming} disabled={mode !== "chat"} onCheckedChange={setStreaming} />
              <Label htmlFor="pg-stream" className="text-muted-foreground">
                Stream {mode !== "chat" && "(chat only)"}
              </Label>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pg-system">System</Label>
            <Textarea id="pg-system" value={system} onChange={(e) => setSystem(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pg-user">User</Label>
            <Textarea
              id="pg-user"
              value={userMsg}
              onChange={(e) => setUserMsg(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !anyBusy) runAll();
              }}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Press <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">⌘</kbd>
              <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">↵</kbd> to run all.
            </p>
          </div>
          {mode === "structured" && (
            <div className="space-y-2">
              <Label htmlFor="pg-schema">JSON schema</Label>
              <Textarea
                id="pg-schema"
                className="font-mono text-xs"
                value={schemaText}
                onChange={(e) => setSchemaText(e.target.value)}
                rows={8}
              />
            </div>
          )}
          {mode === "tools" && (
            <div className="space-y-2">
              <Label htmlFor="pg-tools">Tools (JSON)</Label>
              <Textarea
                id="pg-tools"
                className="font-mono text-xs"
                value={toolsText}
                onChange={(e) => setToolsText(e.target.value)}
                rows={10}
              />
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-wrap items-center gap-3 border-t">
          <Button variant="outline" size="sm" onClick={addColumn} disabled={columns.length >= MAX_COLUMNS}>
            <Plus className="size-4" /> Add model
          </Button>
          <Button onClick={runAll} disabled={anyBusy} className="ml-auto">
            <Play className="size-4" />
            {anyBusy ? "Running…" : `Run all (${columns.length})`}
          </Button>
        </CardFooter>
      </Card>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${Math.min(columns.length, MAX_COLUMNS)}, minmax(0, 1fr))` }}
      >
        {columns.map((col) => (
          <ColumnCard
            key={col.id}
            col={col}
            state={colState[col.id]}
            canRemove={columns.length > 1}
            onChange={(patch) => updateColumn(col.id, patch)}
            onRemove={() => removeColumn(col.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnCard({
  col,
  state,
  canRemove,
  onChange,
  onRemove,
}: {
  col: Column;
  state: ColState | undefined;
  canRemove: boolean;
  onChange: (patch: Partial<Column>) => void;
  onRemove: () => void;
}) {
  const result = state?.result;
  const cost = result ? computeCost(result.model, result.usage.promptTokens, result.usage.completionTokens) : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-2">
          <Select value={col.provider} onValueChange={(p) => onChange({ provider: p, model: defaultModel(p) })}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mock">mock</SelectItem>
              <SelectItem value="anthropic">anthropic</SelectItem>
              <SelectItem value="openai">openai</SelectItem>
            </SelectContent>
          </Select>
          {canRemove && (
            <Button variant="ghost" size="icon" className="size-8" onClick={onRemove}>
              <X className="size-4" />
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={col.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder="model"
            className="h-8"
          />
          <Input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={col.temperature}
            onChange={(e) => onChange({ temperature: Number(e.target.value) })}
            className="h-8"
          />
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {state?.error ? (
          <pre className="overflow-auto border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
            {state.error}
          </pre>
        ) : state?.streamed ? (
          <pre className="overflow-auto border bg-muted/50 p-2 text-xs whitespace-pre-wrap">{state.streamed}</pre>
        ) : result ? (
          <pre className="overflow-auto border bg-muted/50 p-2 text-xs whitespace-pre-wrap">{result.content}</pre>
        ) : state?.busy ? (
          <p className="text-sm text-muted-foreground">Running…</p>
        ) : (
          <p className="text-sm text-muted-foreground">No output yet.</p>
        )}
      </CardContent>
      {result && (
        <CardFooter className="flex-wrap items-center gap-2 border-t text-xs text-muted-foreground">
          <span>
            {result.usage.totalTokens} tok · {cost ? fmtCost(cost.totalCost) : "$0"}
          </span>
          {result.traceId && (
            <Button asChild variant="ghost" size="sm" className="ml-auto h-7">
              <Link to="/traces/$id" params={{ id: result.traceId }}>
                Trace <ArrowRight className="size-3" />
              </Link>
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

/**
 * Save the current comparison as a reproducible experiment: create/append one dataset item
 * for the shared prompt, run each column once (non-streaming, so a trace is recorded), and
 * record one run per column linking the item → that column's trace. Because recordRun pins
 * the dataset's current version, the saved comparison is reproducible.
 */
function SaveAsExperimentDialog({
  columns,
  messages,
  disabled,
}: {
  columns: Column[];
  messages: () => { role: "system" | "user"; content: string }[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!datasetName) return;
    setSaving(true);
    try {
      const msgs = messages();
      await api.createDataset(datasetName, "Saved from playground");
      const added = await api.addDatasetItems(datasetName, [{ input: msgs }]);
      const itemId = added.itemIds[0];
      if (!itemId) throw new Error("failed to create dataset item");
      // Run each column non-streaming so it records a trace, then link it to the item.
      await Promise.all(
        columns.map(async (col) => {
          const r = await api.playgroundChat({
            provider: col.provider,
            model: col.model,
            temperature: col.temperature,
            messages: msgs,
          });
          if (r.traceId) {
            await api.recordRun(datasetName, `${col.provider}/${col.model}`, [
              { datasetItemId: itemId, traceId: r.traceId },
            ]);
          }
        }),
      );
      toast.success(`Saved to dataset "${datasetName}" (${columns.length} runs)`);
      setOpen(false);
      setDatasetName("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Save className="mr-1.5 size-4" /> Save as experiment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as experiment</DialogTitle>
          <DialogDescription>
            Creates a dataset item from the shared prompt and records one run per column (each pinned to the dataset's
            current version).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="save-dataset">Dataset name</Label>
          <Input
            id="save-dataset"
            placeholder="playground-compare"
            value={datasetName}
            onChange={(e) => setDatasetName(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button disabled={!datasetName || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
