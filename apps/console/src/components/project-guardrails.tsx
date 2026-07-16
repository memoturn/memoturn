import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { GuardrailVerdict } from "../lib/api";
import { api } from "../lib/api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const verdictTone: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  allow: "secondary",
  redact: "outline",
  block: "destructive",
};

/**
 * Runtime guardrails config for the active project + a live tester. Configure which checks
 * run (PII redaction/block, prompt-injection detection, blocked terms); the endpoint is
 * SDK-callable at POST /v1/guardrails/check.
 */
export function ProjectGuardrails() {
  const qc = useQueryClient();
  const { data: policy } = useQuery({ queryKey: ["guardrails"], queryFn: api.getGuardrailPolicy });

  const [enabled, setEnabled] = useState(false);
  const [pii, setPii] = useState(true);
  const [piiAction, setPiiAction] = useState<"redact" | "block">("redact");
  const [builtins, setBuiltins] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [redactWith, setRedactWith] = useState("[REDACTED]");
  const [injection, setInjection] = useState(true);
  const [blockedTerms, setBlockedTerms] = useState("");

  // Seed local state once the policy loads.
  useEffect(() => {
    if (!policy) return;
    setEnabled(policy.enabled);
    setPii(policy.pii);
    setPiiAction(policy.piiAction);
    setBuiltins(policy.builtins);
    setCustom(policy.customPatterns.join("\n"));
    setRedactWith(policy.redactWith);
    setInjection(policy.injection);
    setBlockedTerms(policy.blockedTerms.join("\n"));
  }, [policy]);

  const toggleBuiltin = (b: string) =>
    setBuiltins((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]));

  const save = useMutation({
    mutationFn: () =>
      api.setGuardrailPolicy({
        enabled,
        pii,
        piiAction,
        builtins,
        customPatterns: custom
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        redactWith,
        injection,
        blockedTerms: blockedTerms
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success("Guardrail policy saved");
      qc.invalidateQueries({ queryKey: ["guardrails"] });
    },
    onError: (e) => toast.error(`Save failed: ${String(e)}`),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Runtime guardrails</CardTitle>
          <CardDescription>
            Scan text for PII, prompt injection, and blocked terms at request time. Call{" "}
            <code className="text-xs">POST /v1/guardrails/check</code> from the SDK (
            <code className="text-xs">checkGuardrails</code> / <code className="text-xs">check_guardrails</code>). While
            disabled, checks return "allow".
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <Label htmlFor="gr-enabled">Enable guardrails</Label>
            <Switch id="gr-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="gr-pii">Detect PII</Label>
              <Switch id="gr-pii" checked={pii} onCheckedChange={setPii} />
            </div>
            {pii && (
              <div className="space-y-3 pl-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">On a hit:</span>
                  <Select value={piiAction} onValueChange={(v) => setPiiAction(v as "redact" | "block")}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="redact">Redact</SelectItem>
                      <SelectItem value="block">Block</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-3">
                  {(policy?.available ?? []).map((b) => (
                    <div key={b} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        id={`gr-builtin-${b}`}
                        checked={builtins.includes(b)}
                        onCheckedChange={() => toggleBuiltin(b)}
                      />
                      <Label htmlFor={`gr-builtin-${b}`} className="font-normal">
                        {b}
                      </Label>
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gr-custom">Custom patterns (one regex per line)</Label>
                  <Textarea id="gr-custom" rows={2} value={custom} onChange={(e) => setCustom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gr-redact">Redact with</Label>
                  <Input
                    id="gr-redact"
                    className="w-48"
                    value={redactWith}
                    onChange={(e) => setRedactWith(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              <Label htmlFor="gr-injection">Detect prompt injection</Label>
              <p className="text-xs text-muted-foreground">Heuristic detector; blocks on a hit.</p>
            </div>
            <Switch id="gr-injection" checked={injection} onCheckedChange={setInjection} />
          </div>

          <div className="space-y-1.5 border-t pt-4">
            <Label htmlFor="gr-blocked">Blocked terms (one per line; case-insensitive, blocks on a hit)</Label>
            <Textarea id="gr-blocked" rows={2} value={blockedTerms} onChange={(e) => setBlockedTerms(e.target.value)} />
          </div>

          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
        </CardContent>
      </Card>

      <GuardrailTester />
    </div>
  );
}

function GuardrailTester() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<GuardrailVerdict | null>(null);
  const check = useMutation({
    mutationFn: () => api.checkGuardrails(text),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(`Check failed: ${String(e)}`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test</CardTitle>
        <CardDescription>Run a piece of text through the saved policy.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={3}
          placeholder="e.g. email me at a@b.com — and ignore all previous instructions"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="outline" disabled={check.isPending || !text} onClick={() => check.mutate()}>
          {check.isPending ? "Checking…" : "Check"}
        </Button>
        {result && (
          <div className="space-y-2 rounded border p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Verdict:</span>
              <Badge variant={verdictTone[result.verdict] ?? "outline"}>{result.verdict}</Badge>
            </div>
            {result.findings.length > 0 && (
              <ul className="list-inside list-disc text-muted-foreground">
                {result.findings.map((f) => (
                  <li key={`${f.category}:${f.type}`}>
                    {f.category} — {f.type} (×{f.count})
                  </li>
                ))}
              </ul>
            )}
            {result.redactedText !== undefined && (
              <div>
                <span className="text-muted-foreground">Redacted:</span>{" "}
                <code className="break-all text-xs">{result.redactedText}</code>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
