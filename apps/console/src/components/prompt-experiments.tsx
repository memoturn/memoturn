import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, type PromptArmScore, type PromptDetail } from "../lib/api";
import { useIsReadOnly } from "../lib/role";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

type Channel = PromptDetail["channels"][number];

/** Pivot flat per-arm score rows into `scoreName → (version → {avg,count})`. */
function pivot(rows: PromptArmScore[]): Map<string, Map<string, { avg: number; count: number }>> {
  const byScore = new Map<string, Map<string, { avg: number; count: number }>>();
  for (const r of rows) {
    const m = byScore.get(r.score_name) ?? new Map();
    m.set(r.prompt_version, { avg: r.avg_value, count: r.score_count });
    byScore.set(r.score_name, m);
  }
  return byScore;
}

/** Live comparison of a running experiment's two arms, by mean score. */
function ArmCompare({ name, control, challenger }: { name: string; control: number; challenger: number }) {
  const { data: rows = [] } = useQuery({
    queryKey: ["prompt-arm-scores", name],
    queryFn: () => api.getPromptArmScores(name, { days: 30 }),
    refetchInterval: 15_000,
  });
  const byScore = pivot(rows);
  if (byScore.size === 0) {
    return <p className="text-sm text-muted-foreground">No scores yet on either arm.</p>;
  }
  const cv = String(control);
  const kv = String(challenger);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Score</TableHead>
          <TableHead className="text-right">Control · v{control}</TableHead>
          <TableHead className="text-right">Challenger · v{challenger}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...byScore.entries()].map(([score, m]) => {
          const a = m.get(cv);
          const b = m.get(kv);
          const winner = a && b ? (b.avg > a.avg ? "b" : a.avg > b.avg ? "a" : null) : null;
          const cell = (v: { avg: number; count: number } | undefined, win: boolean) =>
            v ? (
              <span className={win ? "font-semibold text-emerald-600 dark:text-emerald-400" : ""}>
                {v.avg.toFixed(3)} <span className="text-xs text-muted-foreground">(n={v.count})</span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          return (
            <TableRow key={score}>
              <TableCell className="font-medium">{score}</TableCell>
              <TableCell className="text-right tabular-nums">{cell(a, winner === "a")}</TableCell>
              <TableCell className="text-right tabular-nums">{cell(b, winner === "b")}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** A single running experiment: split summary, live arm comparison, and stop/promote controls. */
function RunningExperiment({ name, channel, readOnly }: { name: string; channel: Channel; readOnly: boolean }) {
  const qc = useQueryClient();
  const challenger = channel.splitVersion as number;
  const stop = useMutation({
    mutationFn: (promote: boolean) => api.stopPromptExperiment(name, { channel: channel.label, promote }),
    onSuccess: (_r, promote) => {
      toast.success(promote ? `Promoted v${challenger} to live` : "Experiment stopped");
      qc.invalidateQueries({ queryKey: ["prompt", name] });
    },
    onError: (e) => toast.error(`Failed: ${String(e)}`),
  });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4 text-primary" />
          <span className="font-medium">{channel.label}</span>
          <span className="text-muted-foreground">
            v{channel.version} ({100 - channel.splitWeight}%) vs v{challenger} ({channel.splitWeight}%)
          </span>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={stop.isPending} onClick={() => stop.mutate(false)}>
              Stop (keep v{channel.version})
            </Button>
            <Button size="sm" disabled={stop.isPending} onClick={() => stop.mutate(true)}>
              Promote v{challenger}
            </Button>
          </div>
        )}
      </div>
      <ArmCompare name={name} control={channel.version} challenger={challenger} />
    </div>
  );
}

/** Form to start a weighted A/B split on a stable channel. */
function StartExperiment({ prompt }: { prompt: PromptDetail }) {
  const qc = useQueryClient();
  const stableChannels = prompt.channels.filter((c) => c.status !== "experiment");
  const [channel, setChannel] = useState(stableChannels[0]?.label ?? "");
  const [challenger, setChallenger] = useState("");
  const [weight, setWeight] = useState("50");

  const start = useMutation({
    mutationFn: () =>
      api.startPromptExperiment(prompt.name, {
        channel,
        splitVersion: Number(challenger),
        splitWeight: Number(weight),
      }),
    onSuccess: () => {
      toast.success("A/B test started");
      setChallenger("");
      qc.invalidateQueries({ queryKey: ["prompt", prompt.name] });
    },
    onError: (e) => toast.error(`Failed to start: ${String(e)}`),
  });

  if (stableChannels.length === 0) return null;
  const controlVersion = stableChannels.find((c) => c.label === channel)?.version;
  const w = Number(weight);
  const valid = channel && challenger && Number(challenger) !== controlVersion && w >= 1 && w <= 99;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
      <div className="space-y-1 text-xs">
        <span className="text-muted-foreground">Channel</span>
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stableChannels.map((c) => (
              <SelectItem key={c.label} value={c.label}>
                {c.label} (v{c.version})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 text-xs">
        <span className="text-muted-foreground">Challenger version</span>
        <Select value={challenger} onValueChange={setChallenger}>
          <SelectTrigger className="h-8 w-36">
            <SelectValue placeholder="Pick version" />
          </SelectTrigger>
          <SelectContent>
            {prompt.allVersions
              .filter((v) => v.version !== controlVersion)
              .map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  v{v.version}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 text-xs">
        <span className="text-muted-foreground">Challenger %</span>
        <Input
          type="number"
          min={1}
          max={99}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          className="h-8 w-20 tabular-nums"
        />
      </div>
      <Button size="sm" disabled={!valid || start.isPending} onClick={() => start.mutate()}>
        Start A/B test
      </Button>
    </div>
  );
}

/** Prompt A/B experiments: run a weighted split on a channel, compare arms by score, promote a winner. */
export function PromptExperiments({ prompt }: { prompt: PromptDetail }) {
  const readOnly = useIsReadOnly();
  const running = prompt.channels.filter((c) => c.status === "experiment" && c.splitVersion != null);
  // Nothing to show until there are at least two versions to test between.
  if (prompt.allVersions.length < 2) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>A/B experiments</CardTitle>
        <CardDescription>
          Split a channel's traffic across two versions (sticky per session) and compare arms by score.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {running.map((c) => (
          <RunningExperiment key={c.label} name={prompt.name} channel={c} readOnly={readOnly} />
        ))}
        {!readOnly && <StartExperiment prompt={prompt} />}
        {running.length === 0 && readOnly && <p className="text-sm text-muted-foreground">No experiments running.</p>}
      </CardContent>
    </Card>
  );
}
