import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as C from "@memoturn/contracts";
import { ingestRequest } from "@memoturn/core";
import {
  addDatasetItems,
  addReviewItems,
  applyRetention,
  auth,
  builtinModelPrices,
  createAutomation,
  createComment,
  createDataset,
  createEvaluator,
  createModelPrice,
  createPromptVersion,
  createProviderConnection,
  createReviewQueue,
  createSavedView,
  createScoreConfig,
  createWebhook,
  createWidget,
  deleteAutomation,
  deleteComment,
  deleteModelPrice,
  deleteSavedView,
  deleteScoreConfig,
  deleteWebhook,
  deleteWidget,
  exportTracesJsonl,
  getDatasetDetail,
  getMetrics,
  getPromptDetail,
  getRetention,
  getScheduledExport,
  getTrace,
  listAuditLogs,
  listAutomations,
  listComments,
  listDatasets,
  listEvaluators,
  listModelPrices,
  listPrompts,
  listProviderConnections,
  listReviewItems,
  listReviewQueues,
  listSavedViews,
  listScoreConfigs,
  listSessions,
  listTraces,
  listUserProjects,
  listWebhooks,
  listWidgets,
  otlpToEvents,
  recordAudit,
  recordRun,
  resolvePrompt,
  runBatchAction,
  runEvaluator,
  runPlayground,
  runScheduledExport,
  setRetention,
  setScheduledExport,
  streamPlayground,
  submitBatch,
  submitReviewScore,
} from "@memoturn/server";
import { Scalar } from "@scalar/hono-api-reference";
import { streamSSE } from "hono/streaming";
import { type AuthVars, denyIfReadOnly, requireAuth } from "./middleware/auth.js";
import { rateLimit } from "./middleware/ratelimit.js";

/**
 * memoturn public API (Hono + OpenAPI). Runtime-agnostic: the same app is served by
 * the Node and Bun entrypoints. Route handlers are thin — all logic lives in
 * @memoturn/server and @memoturn/core, shared with the dashboard.
 */
type Env = { Variables: AuthVars };

export const app = new OpenAPIHono<Env>();

// ── Better Auth: dashboard auth routes (email/password, sessions) ────────────────
app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

// ── Security scheme + auth on everything under /v1 (except health) ──────────────
app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
  type: "http",
  scheme: "basic",
  description: "Basic auth: publicKey as username, secretKey as password.",
});
app.use("/v1/ingest", requireAuth);
app.use("/v1/otel/*", requireAuth);
app.use("/v1/traces", requireAuth);
app.use("/v1/traces/*", requireAuth);
app.use("/v1/sessions", requireAuth);
app.use("/v1/metrics", requireAuth);
app.use("/v1/prompts", requireAuth);
app.use("/v1/prompts/*", requireAuth);
app.use("/v1/datasets", requireAuth);
app.use("/v1/datasets/*", requireAuth);
app.use("/v1/providers", requireAuth);
app.use("/v1/playground/*", requireAuth);
app.use("/v1/evaluators", requireAuth);
app.use("/v1/evaluators/*", requireAuth);
app.use("/v1/projects", requireAuth);
app.use("/v1/audit-logs", requireAuth);
app.use("/v1/review-queues", requireAuth);
app.use("/v1/review-queues/*", requireAuth);
app.use("/v1/exports/*", requireAuth);
app.use("/v1/retention", requireAuth);
app.use("/v1/retention/*", requireAuth);
app.use("/v1/webhooks", requireAuth);
app.use("/v1/webhooks/*", requireAuth);
app.use("/v1/widgets", requireAuth);
app.use("/v1/widgets/*", requireAuth);
app.use("/v1/comments", requireAuth);
app.use("/v1/comments/*", requireAuth);
app.use("/v1/score-configs", requireAuth);
app.use("/v1/score-configs/*", requireAuth);
app.use("/v1/saved-views", requireAuth);
app.use("/v1/saved-views/*", requireAuth);
app.use("/v1/model-prices", requireAuth);
app.use("/v1/model-prices/*", requireAuth);
app.use("/v1/scheduled-exports", requireAuth);
app.use("/v1/scheduled-exports/*", requireAuth);
app.use("/v1/automations", requireAuth);
app.use("/v1/automations/*", requireAuth);

// Per-project rate limiting runs after auth (projectId is set) on every /v1 route.
app.use("/v1/*", rateLimit);

// Streaming playground (SSE) — plain route; emits { delta } events then [DONE].
app.post("/v1/playground/stream", async (c) => {
  const input = (await c.req.json()) as Parameters<typeof streamPlayground>[1];
  return streamSSE(c, async (s) => {
    try {
      for await (const delta of streamPlayground(c.get("projectId"), input)) {
        await s.writeSSE({ data: JSON.stringify({ delta }) });
      }
      await s.writeSSE({ data: "[DONE]" });
    } catch (err) {
      await s.writeSSE({ data: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) });
    }
  });
});

// Batch export (NDJSON download) — plain route so we can set a file download header.
app.get("/v1/exports/traces", async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get("limit") ?? 1000);
  const environment = url.searchParams.get("environment") || undefined;
  const body = await exportTracesJsonl(c.get("projectId"), { limit, environment });
  return c.body(body, 200, {
    "content-type": "application/x-ndjson",
    "content-disposition": "attachment; filename=memoturn-traces.jsonl",
  });
});

const security = [{ apiKey: [] }];

// ── Health ───────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/health",
    summary: "Liveness probe",
    tags: ["system"],
    responses: {
      200: {
        description: "ok",
        content: { "application/json": { schema: z.object({ status: z.string(), service: z.string() }) } },
      },
    },
  }),
  (c) => c.json({ status: "ok", service: "memoturn-api" }),
);

// ── Ingest ─────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/ingest",
    summary: "Async batched ingestion of traces, observations, and scores",
    tags: ["ingestion"],
    security,
    request: {
      body: {
        content: { "application/json": { schema: z.object({ batch: z.array(z.record(z.string(), z.any())) }) } },
      },
    },
    responses: {
      207: {
        description: "Per-event status",
        content: {
          "application/json": { schema: z.object({ successes: z.array(z.any()), errors: z.array(z.any()) }) },
        },
      },
      400: { description: "Invalid batch" },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = ingestRequest.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid batch", details: z.flattenError(parsed.error) }, 400);

    await submitBatch(c.get("projectId"), parsed.data);
    const successes = parsed.data.batch.map((e) => ({ id: e.id, status: 201 }));
    return c.json({ successes, errors: [] }, 207);
  },
);

// ── OTel OTLP/HTTP receiver (JSON) ───────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/otel/v1/traces",
    summary: "OpenTelemetry OTLP/HTTP traces receiver (GenAI semconv)",
    tags: ["ingestion"],
    security,
    request: { body: { content: { "application/json": { schema: z.record(z.string(), z.any()) } } } },
    responses: {
      200: { description: "Accepted (OTLP partialSuccess)" },
      401: { description: "Unauthorized" },
      415: { description: "Unsupported content type" },
    },
  }),
  async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("json")) {
      return c.json({ error: "only application/json OTLP is supported" }, 415);
    }
    const payload = await c.req.json().catch(() => null);
    const events = otlpToEvents(payload ?? {});
    if (events.length > 0) {
      const parsed = ingestRequest.safeParse({ batch: events });
      if (!parsed.success) return c.json({ error: "mapping failed" }, 400);
      await submitBatch(c.get("projectId"), parsed.data);
    }
    return c.json({ partialSuccess: {} }, 200);
  },
);

// ── Batch actions on traces ──────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/traces/batch",
    summary: "Bulk action on selected traces: delete | add-to-dataset | review",
    tags: ["traces"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              action: z.enum(["delete", "add-to-dataset", "review"]),
              traceIds: z.array(z.string()).min(1),
              datasetName: z.string().optional(),
              queueName: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Result", content: { "application/json": { schema: z.any() } } },
      400: { description: "Bad request" },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await runBatchAction(c.get("projectId"), body);
    if (!result) return c.json({ error: "missing datasetName/queueName for action" }, 400);
    await recordAudit(c.get("projectId"), c.get("actor"), `batch.${body.action}`, `${body.traceIds.length} traces`);
    return c.json(result);
  },
);

// ── Read: list + get traces ──────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/traces",
    summary: "List recent traces",
    tags: ["traces"],
    security,
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        userId: z.string().optional(),
        sessionId: z.string().optional(),
        environment: z.string().optional(),
        search: z.string().optional(),
        tag: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Trace list", content: { "application/json": { schema: C.listOf(C.traceSummary) } } },
    },
  }),
  async (c) => {
    const { limit, userId, sessionId, environment, search, tag } = c.req.valid("query");
    const data = await listTraces(c.get("projectId"), { limit, userId, sessionId, environment, search, tag });
    return c.json({ data });
  },
);

// ── Sessions ─────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/sessions",
    summary: "List sessions (traces grouped by session_id)",
    tags: ["traces"],
    security,
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
    responses: {
      200: { description: "Session list", content: { "application/json": { schema: C.listOf(C.sessionSummary) } } },
    },
  }),
  async (c) => {
    const data = await listSessions(c.get("projectId"), c.req.valid("query").limit ?? 50);
    return c.json({ data });
  },
);

// ── Metrics ──────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/metrics",
    summary: "Cost / token / latency rollups (by day + by model)",
    tags: ["metrics"],
    security,
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }) },
    responses: {
      200: { description: "Metrics summary", content: { "application/json": { schema: C.metricsSummary } } },
    },
  }),
  async (c) => {
    const data = await getMetrics(c.get("projectId"), c.req.valid("query").days ?? 30);
    return c.json(data);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/traces/{id}",
    summary: "Get a single assembled trace with its observations",
    tags: ["traces"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Trace", content: { "application/json": { schema: C.traceDetail } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const trace = await getTrace(c.get("projectId"), c.req.valid("param").id);
    if (!trace) return c.json({ error: "not found" }, 404);
    return c.json(trace);
  },
);

// ── Prompts: list ────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/prompts",
    summary: "List prompts (with channels + latest version)",
    tags: ["prompts"],
    security,
    responses: {
      200: { description: "Prompt list", content: { "application/json": { schema: C.listOf(C.promptListItem) } } },
    },
  }),
  async (c) => {
    const data = await listPrompts(c.get("projectId"));
    return c.json({ data });
  },
);

// ── Prompts: create a new version (and point channels at it) ──────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/prompts",
    summary: "Create a new prompt version; optionally point channels (labels) at it",
    tags: ["prompts"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              type: z.enum(["TEXT", "CHAT"]).optional(),
              content: z.any(),
              config: z.record(z.string(), z.any()).optional(),
              folder: z.string().optional(),
              labels: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created version", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const created = await createPromptVersion(c.get("projectId"), { ...body, content: body.content });
    await recordAudit(c.get("projectId"), c.get("actor"), "prompt.version.create", `prompt:${body.name}`, {
      version: created.version,
    });
    return c.json(created, 201);
  },
);

// ── Prompts: full detail (all versions + channels) ───────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/prompts/{name}/detail",
    summary: "Get a prompt with all versions + channels",
    tags: ["prompts"],
    security,
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: { description: "Prompt detail", content: { "application/json": { schema: C.promptDetail } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const detail = await getPromptDetail(c.get("projectId"), c.req.valid("param").name);
    if (!detail) return c.json({ error: "prompt not found" }, 404);
    return c.json(detail);
  },
);

// ── Prompts: resolve a deployed prompt by channel (used by the SDK) ───────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/prompts/{name}",
    summary: "Resolve a deployed prompt by name + channel",
    tags: ["prompts"],
    security,
    request: { params: z.object({ name: z.string() }), query: z.object({ channel: z.string().optional() }) },
    responses: {
      200: { description: "Compiled prompt", content: { "application/json": { schema: z.any() } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const channel = c.req.valid("query").channel ?? "production";
    const resolved = await resolvePrompt(c.get("projectId"), c.req.valid("param").name, channel);
    if (!resolved) return c.json({ error: `prompt or channel '${channel}' not found` }, 404);
    return c.json(resolved);
  },
);

// ── Datasets: list + create ──────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets",
    summary: "List datasets (with item + run counts)",
    tags: ["datasets"],
    security,
    responses: {
      200: { description: "Dataset list", content: { "application/json": { schema: C.listOf(C.datasetListItem) } } },
    },
  }),
  async (c) => c.json({ data: await listDatasets(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/datasets",
    summary: "Create (or update) a dataset",
    tags: ["datasets"],
    security,
    request: {
      body: {
        content: {
          "application/json": { schema: z.object({ name: z.string().min(1), description: z.string().optional() }) },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await createDataset(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "dataset.create", `dataset:${body.name}`);
    return c.json(result, 201);
  },
);

// ── Datasets: detail (items + runs) ──────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{name}",
    summary: "Get a dataset with items + runs",
    tags: ["datasets"],
    security,
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: { description: "Dataset", content: { "application/json": { schema: C.datasetDetail } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const detail = await getDatasetDetail(c.get("projectId"), c.req.valid("param").name);
    if (!detail) return c.json({ error: "dataset not found" }, 404);
    return c.json(detail);
  },
);

// ── Datasets: add items ──────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/datasets/{name}/items",
    summary: "Append items to a dataset",
    tags: ["datasets"],
    security,
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(
                z.object({
                  input: z.any(),
                  expectedOutput: z.any().optional(),
                  metadata: z.record(z.string(), z.any()).optional(),
                }),
              ),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Added", content: { "application/json": { schema: z.any() } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const items = c.req.valid("json").items as Parameters<typeof addDatasetItems>[2];
    const result = await addDatasetItems(c.get("projectId"), c.req.valid("param").name, items);
    if (!result) return c.json({ error: "dataset not found" }, 404);
    return c.json(result, 201);
  },
);

// ── Datasets: record an experiment run (link items → traces) ──────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/datasets/{name}/runs",
    summary: "Record an experiment run linking dataset items to traces",
    tags: ["datasets"],
    security,
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              runName: z.string().min(1),
              links: z.array(z.object({ datasetItemId: z.string(), traceId: z.string() })),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Recorded", content: { "application/json": { schema: z.any() } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const result = await recordRun(c.get("projectId"), c.req.valid("param").name, body.runName, body.links);
    if (!result) return c.json({ error: "dataset not found" }, 404);
    return c.json(result, 201);
  },
);

// ── Providers (LLM connections) ──────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/providers",
    summary: "List configured LLM provider connections (masked)",
    tags: ["providers"],
    security,
    responses: {
      200: {
        description: "Provider list",
        content: { "application/json": { schema: C.listOf(C.providerConnection) } },
      },
    },
  }),
  async (c) => c.json({ data: await listProviderConnections(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/providers",
    summary: "Add/update an LLM provider API key (encrypted at rest)",
    tags: ["providers"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ provider: z.enum(["anthropic", "openai"]), apiKey: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      201: { description: "Saved", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const { provider, apiKey } = c.req.valid("json");
    const result = await createProviderConnection(c.get("projectId"), provider, apiKey);
    await recordAudit(c.get("projectId"), c.get("actor"), "provider.connect", `provider:${provider}`);
    return c.json(result, 201);
  },
);

// ── Playground ───────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/playground/chat",
    summary: "Run a one-shot chat completion through the provider gateway",
    tags: ["playground"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              provider: z.enum(["mock", "anthropic", "openai"]),
              model: z.string(),
              messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })),
              temperature: z.number().optional(),
              maxTokens: z.number().int().optional(),
              trace: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Completion", content: { "application/json": { schema: z.any() } } },
      400: { description: "Error" },
    },
  }),
  async (c) => {
    try {
      const { trace, ...input } = c.req.valid("json");
      const result = await runPlayground(c.get("projectId"), input, { trace });
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  },
);

// ── Evaluators (LLM-as-judge) ────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/evaluators",
    summary: "List evaluators",
    tags: ["evaluators"],
    security,
    responses: {
      200: { description: "Evaluator list", content: { "application/json": { schema: C.listOf(C.evaluator) } } },
    },
  }),
  async (c) => c.json({ data: await listEvaluators(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/evaluators",
    summary: "Create/update an LLM-as-judge evaluator",
    tags: ["evaluators"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              prompt: z.string().min(1),
              provider: z.enum(["mock", "anthropic", "openai"]).optional(),
              model: z.string(),
              online: z.boolean().optional(),
              samplingRate: z.number().min(0).max(1).optional(),
              filterName: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await createEvaluator(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "evaluator.create", `evaluator:${body.name}`);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/evaluators/{name}/run",
    summary: "Run an evaluator over a trace's input/output (writes an EVAL score)",
    tags: ["evaluators"],
    security,
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              traceId: z.string(),
              input: z.any(),
              output: z.any(),
              expectedOutput: z.any().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Score", content: { "application/json": { schema: z.any() } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const result = await runEvaluator(c.get("projectId"), c.req.valid("param").name, c.req.valid("json"));
    if (!result) return c.json({ error: "evaluator not found" }, 404);
    return c.json(result);
  },
);

// ── Projects (for the dashboard project switcher) ────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/projects",
    summary: "List projects the caller can access",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Project list", content: { "application/json": { schema: C.listOf(C.project) } } },
    },
  }),
  async (c) => {
    const userId = c.get("userId");
    if (userId) return c.json({ data: await listUserProjects(userId) });
    // API key: scoped to its single project.
    return c.json({
      data: [{ id: c.get("projectId"), name: "(api-key project)", slug: "", workspace: "", role: c.get("role") }],
    });
  },
);

// ── Audit logs ───────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/audit-logs",
    summary: "Recent audit log entries for the active project",
    tags: ["platform"],
    security,
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
    responses: {
      200: { description: "Audit log", content: { "application/json": { schema: C.listOf(C.auditEntry) } } },
    },
  }),
  async (c) => c.json({ data: await listAuditLogs(c.get("projectId"), c.req.valid("query").limit ?? 100) }),
);

// ── Review queues (human annotation) ─────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/review-queues",
    summary: "List review queues (with pending/done counts)",
    tags: ["review"],
    security,
    responses: {
      200: { description: "Queue list", content: { "application/json": { schema: C.listOf(C.reviewQueue) } } },
    },
  }),
  async (c) => c.json({ data: await listReviewQueues(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/review-queues",
    summary: "Create a review queue",
    tags: ["review"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              description: z.string().optional(),
              scoreName: z.string().min(1),
              dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await createReviewQueue(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "review-queue.create", `queue:${body.name}`);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/review-queues/{name}/items",
    summary: "Enqueue traces for review",
    tags: ["review"],
    security,
    request: {
      params: z.object({ name: z.string() }),
      body: { content: { "application/json": { schema: z.object({ traceIds: z.array(z.string()).min(1) }) } } },
    },
    responses: {
      201: { description: "Added", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const result = await addReviewItems(c.get("projectId"), c.req.valid("param").name, c.req.valid("json").traceIds);
    if (!result) return c.json({ error: "queue not found" }, 404);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/review-queues/{name}/items",
    summary: "List items to review (with trace input/output)",
    tags: ["review"],
    security,
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ status: z.enum(["PENDING", "DONE", "SKIPPED"]).optional() }),
    },
    responses: {
      200: { description: "Items", content: { "application/json": { schema: C.reviewItemsResponse } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const result = await listReviewItems(
      c.get("projectId"),
      c.req.valid("param").name,
      c.req.valid("query").status ?? "PENDING",
    );
    if (!result) return c.json({ error: "queue not found" }, 404);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/review-queues/{name}/items/{itemId}/score",
    summary: "Submit a human score for a review item (writes an ANNOTATION score)",
    tags: ["review"],
    security,
    request: {
      params: z.object({ name: z.string(), itemId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              value: z.number().optional(),
              stringValue: z.string().optional(),
              comment: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Scored", content: { "application/json": { schema: z.any() } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { name, itemId } = c.req.valid("param");
    const result = await submitReviewScore(c.get("projectId"), name, itemId, c.req.valid("json"));
    if (!result) return c.json({ error: "queue or item not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "review.score", `trace:${result.traceId}`, { score: name });
    return c.json(result);
  },
);

// ── Data retention ───────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/retention",
    summary: "Get the project's retention policy (days; 0 = keep forever)",
    tags: ["platform"],
    security,
    responses: { 200: { description: "Policy", content: { "application/json": { schema: z.any() } } } },
  }),
  async (c) => c.json(await getRetention(c.get("projectId"))),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/retention",
    summary: "Set the project's retention policy (days)",
    tags: ["platform"],
    security,
    request: { body: { content: { "application/json": { schema: z.object({ days: z.number().int().min(0) }) } } } },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const { days } = c.req.valid("json");
    const result = await setRetention(c.get("projectId"), days);
    await recordAudit(c.get("projectId"), c.get("actor"), "retention.set", `days:${days}`);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/retention/apply",
    summary: "Apply retention now (delete telemetry older than the policy)",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Result", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const projectId = c.get("projectId");
    const { days } = await getRetention(projectId);
    const result = await applyRetention(projectId, days);
    await recordAudit(projectId, c.get("actor"), "retention.apply", `deleted:${result.deletedTraces}`);
    return c.json(result);
  },
);

// ── Webhooks / automations ───────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/webhooks",
    summary: "List webhooks",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Webhook list", content: { "application/json": { schema: C.listOf(C.webhook) } } },
    },
  }),
  async (c) => c.json({ data: await listWebhooks(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/webhooks",
    summary: "Create a webhook (POSTs on an event; score.created supports a low-score threshold)",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              url: z.string().url(),
              event: z.enum(["score.created"]).optional(),
              threshold: z.number().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.webhook.partial() } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await createWebhook(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "webhook.create", `webhook:${result.id}`, { url: body.url });
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/webhooks/{id}",
    summary: "Delete a webhook",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const result = await deleteWebhook(c.get("projectId"), c.req.valid("param").id);
    await recordAudit(c.get("projectId"), c.get("actor"), "webhook.delete", `webhook:${c.req.valid("param").id}`);
    return c.json(result);
  },
);

// ── Dashboard widgets ────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/widgets",
    summary: "List dashboard widgets (with computed data series)",
    tags: ["platform"],
    security,
    responses: { 200: { description: "Widget list", content: { "application/json": { schema: C.listOf(C.widget) } } } },
  }),
  async (c) => c.json({ data: await listWidgets(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/widgets",
    summary: "Create a dashboard widget",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              metric: C.widgetMetric.optional(),
              breakdown: C.widgetBreakdown.optional(),
              days: z.number().int().min(1).max(365).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.widget } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const result = await createWidget(c.get("projectId"), c.req.valid("json"));
    await recordAudit(c.get("projectId"), c.get("actor"), "widget.create", `widget:${result.id}`);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/widgets/{id}",
    summary: "Delete a dashboard widget",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteWidget(c.get("projectId"), c.req.valid("param").id));
  },
);

// ── Score configs ────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/score-configs",
    summary: "List score configs",
    tags: ["evaluators"],
    security,
    responses: {
      200: { description: "Score configs", content: { "application/json": { schema: C.listOf(C.scoreConfig) } } },
    },
  }),
  async (c) => c.json({ data: await listScoreConfigs(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/score-configs",
    summary: "Create/update a score config",
    tags: ["evaluators"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]).optional(),
              categories: z.array(z.string()).optional(),
              min: z.number().nullable().optional(),
              max: z.number().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.scoreConfig } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const result = await createScoreConfig(c.get("projectId"), c.req.valid("json"));
    await recordAudit(c.get("projectId"), c.get("actor"), "score-config.create", `score:${result.name}`);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/score-configs/{id}",
    summary: "Delete a score config",
    tags: ["evaluators"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteScoreConfig(c.get("projectId"), c.req.valid("param").id));
  },
);

// ── Comments ─────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/comments",
    summary: "List comments on an object (trace/observation/session/prompt)",
    tags: ["platform"],
    security,
    request: { query: z.object({ objectType: z.string(), objectId: z.string() }) },
    responses: { 200: { description: "Comments", content: { "application/json": { schema: C.listOf(C.comment) } } } },
  }),
  async (c) => {
    const { objectType, objectId } = c.req.valid("query");
    return c.json({ data: await listComments(c.get("projectId"), objectType, objectId) });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/comments",
    summary: "Add a comment",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ objectType: z.string(), objectId: z.string(), content: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.comment } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await createComment(c.get("projectId"), c.get("actor"), c.req.valid("json")), 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/comments/{id}",
    summary: "Delete a comment",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteComment(c.get("projectId"), c.req.valid("param").id));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/saved-views",
    summary: "List saved table views",
    tags: ["platform"],
    security,
    request: { query: z.object({ table: z.string().optional() }) },
    responses: {
      200: { description: "Saved views", content: { "application/json": { schema: C.listOf(C.savedView) } } },
    },
  }),
  async (c) => {
    const { table } = c.req.valid("query");
    return c.json({ data: await listSavedViews(c.get("projectId"), table) });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/saved-views",
    summary: "Save a table view (named set of filters)",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              table: z.string().optional(),
              filters: z.record(z.string(), z.any()),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.savedView } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const view = await createSavedView(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "saved-view.create", `view:${body.name}`);
    return c.json(view, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/saved-views/{id}",
    summary: "Delete a saved view",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteSavedView(c.get("projectId"), c.req.valid("param").id));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/model-prices",
    summary: "List custom model price overrides (plus the built-in defaults for reference)",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Model prices", content: { "application/json": { schema: C.modelPriceList } } },
    },
  }),
  async (c) => c.json({ data: await listModelPrices(c.get("projectId")), builtins: builtinModelPrices() }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/model-prices",
    summary: "Create or update a model price override (matched by name pattern, overrides built-ins)",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              pattern: z.string().min(1),
              provider: z.string().optional(),
              inputPerMTok: z.number().nonnegative(),
              outputPerMTok: z.number().nonnegative(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.modelPrice } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const price = await createModelPrice(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "model-price.set", `pattern:${body.pattern}`);
    return c.json(price, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/model-prices/{id}",
    summary: "Delete a model price override",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteModelPrice(c.get("projectId"), c.req.valid("param").id));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/scheduled-exports",
    summary: "Get the project's scheduled blob-export config (with last-run status)",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Config", content: { "application/json": { schema: C.scheduledExport } } },
    },
  }),
  async (c) => c.json(await getScheduledExport(c.get("projectId"))),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/scheduled-exports",
    summary: "Configure the recurring daily export of traces (NDJSON) to blob storage",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean().optional(),
              environment: z.string().optional(),
              limit: z.number().int().positive().max(100000).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: C.scheduledExport } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await setScheduledExport(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "scheduled-export.set", `enabled:${result.enabled}`);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/scheduled-exports/run",
    summary: "Run the export now and write the NDJSON to blob storage",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Result", content: { "application/json": { schema: C.scheduledExportResult } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const projectId = c.get("projectId");
    const result = await runScheduledExport(projectId);
    await recordAudit(projectId, c.get("actor"), "scheduled-export.run", `count:${result.count}`);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/automations",
    summary: "List trigger->action automations",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "Automations", content: { "application/json": { schema: C.listOf(C.automation) } } },
    },
  }),
  async (c) => c.json({ data: await listAutomations(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/automations",
    summary: "Create an automation (trigger: score.created/trace.created/eval.completed; action: webhook/slack)",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              trigger: z.enum(["score.created", "trace.created", "eval.completed"]).optional(),
              action: z.enum(["webhook", "slack"]).optional(),
              target: z.string().url(),
              threshold: z.number().nullable().optional(),
              filter: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.automation } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    const result = await createAutomation(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "automation.create", `${result.trigger}->${result.action}`);
    return c.json(result, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/automations/{id}",
    summary: "Delete an automation",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    return c.json(await deleteAutomation(c.get("projectId"), c.req.valid("param").id));
  },
);

// ── OpenAPI document + Scalar API reference ──────────────────────────────────────
app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "memoturn API",
    version: "0.1.0",
    description: "Open-source AI engineering platform — public ingestion + read API.",
  },
});
app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "memoturn API" }));
