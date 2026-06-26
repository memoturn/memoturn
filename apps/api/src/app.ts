import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ingestRequest } from "@memoturn/core";
import {
  addDatasetItems,
  addReviewItems,
  applyRetention,
  auth,
  createDataset,
  createEvaluator,
  createPromptVersion,
  createProviderConnection,
  createReviewQueue,
  exportTracesJsonl,
  getDatasetDetail,
  getMetrics,
  getPromptDetail,
  getRetention,
  getTrace,
  listAuditLogs,
  listDatasets,
  listEvaluators,
  listPrompts,
  listProviderConnections,
  listReviewItems,
  listReviewQueues,
  listSessions,
  listTraces,
  listUserProjects,
  otlpToEvents,
  recordAudit,
  recordRun,
  resolvePrompt,
  runEvaluator,
  runPlayground,
  setRetention,
  streamPlayground,
  submitBatch,
  submitReviewScore,
} from "@memoturn/server";
import { Scalar } from "@scalar/hono-api-reference";
import { streamSSE } from "hono/streaming";
import { type AuthVars, denyIfReadOnly, requireAuth } from "./middleware/auth.js";

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
      }),
    },
    responses: { 200: { description: "Trace list", content: { "application/json": { schema: z.any() } } } },
  }),
  async (c) => {
    const { limit, userId, sessionId, environment, search } = c.req.valid("query");
    const data = await listTraces(c.get("projectId"), { limit, userId, sessionId, environment, search });
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
    responses: { 200: { description: "Session list", content: { "application/json": { schema: z.any() } } } },
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
    responses: { 200: { description: "Metrics summary", content: { "application/json": { schema: z.any() } } } },
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
      200: { description: "Trace", content: { "application/json": { schema: z.any() } } },
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
    responses: { 200: { description: "Prompt list", content: { "application/json": { schema: z.any() } } } },
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
      200: { description: "Prompt detail", content: { "application/json": { schema: z.any() } } },
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
    responses: { 200: { description: "Dataset list", content: { "application/json": { schema: z.any() } } } },
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
      200: { description: "Dataset", content: { "application/json": { schema: z.any() } } },
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
    responses: { 200: { description: "Provider list", content: { "application/json": { schema: z.any() } } } },
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
    responses: { 200: { description: "Evaluator list", content: { "application/json": { schema: z.any() } } } },
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
    responses: { 200: { description: "Project list", content: { "application/json": { schema: z.any() } } } },
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
    responses: { 200: { description: "Audit log", content: { "application/json": { schema: z.any() } } } },
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
    responses: { 200: { description: "Queue list", content: { "application/json": { schema: z.any() } } } },
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
      200: { description: "Items", content: { "application/json": { schema: z.any() } } },
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
