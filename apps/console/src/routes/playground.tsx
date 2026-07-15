import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { api, type PlaygroundResponse, streamPlayground } from "../lib/api";

export const Route = createFileRoute("/playground")({ component: PlaygroundPage });

type Mode = "chat" | "structured" | "tools";

function PlaygroundPage() {
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("mock-1");
  const [system, setSystem] = useState("You are a helpful assistant.");
  const [userMsg, setUserMsg] = useState("Explain what memoturn is in one sentence.");
  const [temperature, setTemperature] = useState(0.2);
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
  const [streamed, setStreamed] = useState("");
  const [result, setResult] = useState<PlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the response to the true bottom as it streams / resolves (not just the anchor top).
  useEffect(() => {
    if (busy || streamed || result || error) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [busy, streamed, result, error]);

  // Sensible default model per provider.
  function onProvider(p: string) {
    setProvider(p);
    setModel(p === "anthropic" ? "claude-sonnet-4-6" : p === "openai" ? "gpt-4o-mini" : "mock-1");
  }

  // Seed from a trace generation ("Open in Playground"): consume + clear the handoff on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("memoturn.playground.seed");
      if (!raw) return;
      localStorage.removeItem("memoturn.playground.seed");
      const seed = JSON.parse(raw) as { provider?: string; model?: string; system?: string; userMsg?: string };
      if (seed.provider) setProvider(seed.provider);
      if (seed.model) setModel(seed.model);
      if (typeof seed.system === "string" && seed.system) setSystem(seed.system);
      if (typeof seed.userMsg === "string") setUserMsg(seed.userMsg);
    } catch {
      /* ignore malformed seed */
    }
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setStreamed("");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: userMsg },
    ];
    try {
      const responseFormat =
        mode === "structured" ? { type: "json_schema" as const, schema: JSON.parse(schemaText) } : undefined;
      const tools = mode === "tools" ? JSON.parse(toolsText) : undefined;
      // Tools + structured output only run through the non-streaming path.
      if (mode === "chat" && streaming) {
        await streamPlayground({ provider, model, temperature, messages }, (delta) =>
          setStreamed((prev) => prev + delta),
        );
      } else {
        setResult(await api.playgroundChat({ provider, model, temperature, messages, tools, responseFormat }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Playground" description="Try a prompt against a provider and inspect the response." />

      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
          <CardDescription>Configure a prompt and run it against a provider.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={onProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">mock</SelectItem>
                  <SelectItem value="anthropic">anthropic</SelectItem>
                  <SelectItem value="openai">openai</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pg-model">Model</Label>
              <Input id="pg-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pg-temp">Temperature</Label>
              <Input
                id="pg-temp"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
              />
            </div>
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
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !busy) run();
              }}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Press <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">⌘</kbd>
              <kbd className="rounded border bg-muted px-1 font-mono text-[0.625rem]">↵</kbd> to run.
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
        <CardFooter className="flex-wrap items-center gap-4 border-t">
          <div className="flex items-center gap-2">
            <Switch id="pg-stream" checked={streaming} disabled={mode !== "chat"} onCheckedChange={setStreaming} />
            <Label htmlFor="pg-stream" className="text-muted-foreground">
              Stream {mode !== "chat" && "(chat only)"}
            </Label>
          </div>
          <Button onClick={run} disabled={busy} className="ml-auto">
            <Play className="size-4" />
            {busy ? "Running…" : "Run"}
          </Button>
        </CardFooter>
      </Card>

      <div className="space-y-6">
        {busy && !streamed && !result && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Play className="size-4 animate-pulse text-primary" />
                Running…
              </CardTitle>
              <CardDescription>Waiting for the provider to respond.</CardDescription>
            </CardHeader>
          </Card>
        )}

        {error && (
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Error</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {streamed && (
          <Card>
            <CardHeader>
              <CardTitle>Response (streaming)</CardTitle>
              <CardDescription>Live output streamed from the provider.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto border bg-muted/50 p-3 text-xs whitespace-pre-wrap">{streamed}</pre>
            </CardContent>
          </Card>
        )}

        {result && (
          <Card>
            <CardHeader>
              <CardTitle>Response</CardTitle>
              <CardDescription>
                {result.provider}/{result.model}
              </CardDescription>
              {result.traceId && (
                <CardAction>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/traces/$id" params={{ id: result.traceId }}>
                      View trace
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto border bg-muted/50 p-3 text-xs whitespace-pre-wrap">{result.content}</pre>
            </CardContent>
            <CardFooter className="border-t text-sm text-muted-foreground">
              {result.usage.totalTokens} tokens ({result.usage.promptTokens}+{result.usage.completionTokens})
            </CardFooter>
          </Card>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
