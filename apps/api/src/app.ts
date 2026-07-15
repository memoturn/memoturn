import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as C from "@memoturn/contracts";
import { type IngestEvent, type IngestResult, ingestEvent, ingestRequest, ingestResponse } from "@memoturn/core";
import {
  addDatasetItems,
  addReviewItems,
  annotateTrace,
  applyRetention,
  assertPublicUrl,
  assignReviewItem,
  auth,
  builtinModelPrices,
  checkRateLimit,
  correctScore,
  countSessions,
  countTraces,
  countUsers,
  createApiKey,
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
  decodeOtlpTraces,
  deleteAutomation,
  deleteComment,
  deleteModelPrice,
  deleteSavedView,
  deleteScore,
  deleteScoreConfig,
  deleteWebhook,
  deleteWidget,
  exportTracesCsv,
  exportTracesJsonl,
  getAnalyticsSink,
  getDatasetComparison,
  getDatasetDetail,
  getEvaluatorAnalytics,
  getMaskingPolicy,
  getMedia,
  getMetrics,
  getOffloadedPayload,
  getPromptDetail,
  getRetention,
  getReviewAnalytics,
  getScheduledExport,
  getScoresByTraceIds,
  getTrace,
  ingestRateLimitConfig,
  listApiKeys,
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
  listUsers,
  listWebhooks,
  listWidgets,
  mcpAuthorizationServerMetadata,
  mcpProtectedResourceMetadata,
  otlpToEvents,
  recordAudit,
  recordRun,
  replayTrace,
  resolvePrompt,
  revokeApiKey,
  runBatchAction,
  runEvaluator,
  runPlayground,
  runScheduledExport,
  safeServeContentType,
  setAnalyticsSink,
  setMaskingPolicy,
  setRetention,
  setScheduledExport,
  setTraceTags,
  skipReviewItem,
  storeDataUri,
  streamPlayground,
  submitBatch,
  submitReviewScore,
  traceFacets,
  traceHistogram,
} from "@memoturn/server";
import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { handleMcp } from "./mcp.js";
import { type AuthVars, denyIfReadOnly, requireAuth } from "./middleware/auth.js";
import { rateLimit } from "./middleware/ratelimit.js";

/**
 * memoturn public API (Hono + OpenAPI). Runtime-agnostic: the same app is served by
 * the Node and Bun entrypoints. Route handlers are thin — all logic lives in
 * @memoturn/server and @memoturn/core, shared with the dashboard.
 */
type Env = { Variables: AuthVars };

export const app = new OpenAPIHono<Env>();

// ── Global hardening middleware ──────────────────────────────────────────────────
// Security headers (X-Frame-Options, nosniff, Referrer-Policy, HSTS, …). Defaults are
// kept (no restrictive CSP) so the Scalar /docs UI keeps working.
app.use("*", secureHeaders({ xFrameOptions: "DENY", referrerPolicy: "no-referrer" }));

// CORS for the browser console: explicit trusted origins + credentials (cookie auth).
const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("/v1/*", cors({ origin: trustedOrigins, credentials: true }));
app.use("/auth/*", cors({ origin: trustedOrigins, credentials: true }));

// Request body-size limits (memory-exhaustion DoS guard). Ingest/OTel/media accept large
// payloads; everything else is capped at 1 MB. Exactly one limit applies per request.
const LARGE_BODY_BYTES = 12 * 1024 * 1024;
const DEFAULT_BODY_BYTES = 1 * 1024 * 1024;
const largeBodyLimit = bodyLimit({ maxSize: LARGE_BODY_BYTES });
const defaultBodyLimit = bodyLimit({ maxSize: DEFAULT_BODY_BYTES });
app.use("/v1/*", (c, next) => {
  const p = c.req.path;
  const isLarge =
    p === "/v1/ingest" || p.startsWith("/v1/otel") || p.startsWith("/v1/media") || p.startsWith("/v1/mcp");
  return (isLarge ? largeBodyLimit : defaultBodyLimit)(c, next);
});

// ── Better Auth: dashboard auth routes (email/password, sessions) ────────────────
app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

// ── Remote MCP: per-project Streamable-HTTP endpoint (own API-key auth, see mcp.ts) ─
// Not guarded by requireAuth — the method-based scope gate can't tell read tools from
// writes (every call is a POST), so auth + per-tool RBAC live inside handleMcp.
app.all("/v1/mcp/:projectId", handleMcp);

// OAuth discovery for remote MCP clients (memoturn cloud). MCP clients probe these at the
// domain root; the mcp() plugin serves them under /auth/.well-known/* and these root mounts
// proxy to it. Behind Caddy, route `/.well-known/oauth-*` to the API (see infra/Caddyfile).
app.get("/.well-known/oauth-authorization-server", (c) => mcpAuthorizationServerMetadata(c.req.raw));
app.get("/.well-known/oauth-protected-resource", (c) => mcpProtectedResourceMetadata(c.req.raw));

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
app.use("/v1/users", requireAuth);
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
app.use("/v1/media", requireAuth);
app.use("/v1/media/*", requireAuth);
app.use("/v1/payloads/*", requireAuth);
app.use("/v1/analytics-sink", requireAuth);
app.use("/v1/api-keys", requireAuth);
app.use("/v1/api-keys/*", requireAuth);
app.use("/v1/masking", requireAuth);
app.use("/v1/scores", requireAuth);
app.use("/v1/scores/*", requireAuth);

// Per-project rate limiting runs after auth (projectId is set) on every /v1 route.
app.use("/v1/*", rateLimit);

const security = [{ apiKey: [] }];

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
      console.error(JSON.stringify({ level: "error", scope: "playground.stream", message: String(err) }));
      await s.writeSSE({ data: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) });
    }
  });
});

// Multimodal media — store a base64 data URI (OpenAPI route); the GET below is a plain
// route so it can stream raw bytes with the right content-type.
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/media",
    summary: "Store a base64 data URI as a media attachment",
    tags: ["ingestion"],
    security,
    request: {
      body: { content: { "application/json": { schema: z.object({ dataUri: z.string() }) } } },
    },
    responses: {
      201: { description: "Stored", content: { "application/json": { schema: z.any() } } },
      400: { description: "Bad request" },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const stored = await storeDataUri(c.get("projectId"), c.req.valid("json").dataUri);
    if (!stored) return c.json({ error: "not a base64 data URI" }, 400);
    await recordAudit(c.get("projectId"), c.get("actor"), "media.store", stored.key);
    return c.json({ ...stored, url: `/v1/media/${stored.key}` }, 201);
  },
);

app.get("/v1/media/*", async (c) => {
  const key = c.req.path.replace(/^\/v1\/media\//, "");
  const media = await getMedia(c.get("projectId"), key);
  if (!media) return c.json({ error: "not found" }, 404);
  // Serve inert: force a safe content-type, disable MIME sniffing, and download rather
  // than render inline — so a stored svg/html payload can't execute script same-origin.
  return c.body(media.body.buffer as ArrayBuffer, 200, {
    "content-type": safeServeContentType(media.contentType),
    "content-disposition": "attachment",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000",
  });
});

// Fetch a large input/output payload that was offloaded to blob at ingest (the trace shows
// a {_truncated, ref, preview} marker; the console resolves the full value through here).
app.get("/v1/payloads/*", async (c) => {
  const key = c.req.path.replace(/^\/v1\/payloads\//, "");
  const body = await getOffloadedPayload(c.get("projectId"), key);
  if (body === null) return c.json({ error: "not found" }, 404);
  return c.body(body, 200, { "content-type": "application/json", "cache-control": "private, max-age=31536000" });
});

// Batch export (NDJSON download) — plain route so we can set a file download header.
app.get("/v1/exports/traces", async (c) => {
  const url = new URL(c.req.url);
  const q = url.searchParams;
  const format = q.get("format") === "csv" ? "csv" : "jsonl";
  // Honor the same filters as the trace list so an export matches the on-screen view.
  const filters = {
    limit: Number(q.get("limit") ?? 1000),
    environment: q.get("environment") || undefined,
    search: q.get("search") || undefined,
    userId: q.get("userId") || undefined,
    tag: q.get("tag") || undefined,
    scoreName: q.get("scoreName") || undefined,
    level: q.get("level") || undefined,
    days: q.get("days") ? Number(q.get("days")) : undefined,
  };
  if (format === "csv") {
    const body = await exportTracesCsv(c.get("projectId"), filters);
    return c.body(body, 200, {
      "content-type": "text/csv",
      "content-disposition": "attachment; filename=memoturn-traces.csv",
    });
  }
  const body = await exportTracesJsonl(c.get("projectId"), filters);
  return c.body(body, 200, {
    "content-type": "application/x-ndjson",
    "content-disposition": "attachment; filename=memoturn-traces.jsonl",
  });
});

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
// Envelope-only shape check; each event is validated individually in the handler so
// one bad event yields a per-event 400 in the 207 body instead of failing the batch.
const ingestEnvelope = z.object({ batch: z.array(z.unknown()).min(1).max(1000) });

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/ingest",
    summary: "Async batched ingestion of traces, observations, and scores",
    tags: ["ingestion"],
    security,
    request: {
      body: {
        // Envelope only — events are validated individually in the handler so a bad
        // event becomes a per-event 400 in the 207 body, not a whole-batch reject.
        content: { "application/json": { schema: ingestEnvelope } },
      },
    },
    responses: {
      207: {
        description: "Per-event status: accepted events under `successes`, rejected events under `errors`",
        content: {
          "application/json": { schema: ingestResponse },
        },
      },
      400: { description: "Invalid batch" },
      401: { description: "Unauthorized" },
      429: { description: "Event rate limit exceeded" },
    },
  }),
  async (c) => {
    const json = await c.req.json().catch(() => null);
    // Envelope first (shape + batch size), then each event individually: one malformed
    // event must not 400 the whole batch, and the 207 must report REAL per-event results
    // — the previous handler acked every event unconditionally, hiding rejects in the DLQ.
    const envelope = ingestEnvelope.safeParse(json);
    if (!envelope.success) return c.json({ error: "invalid batch", details: z.flattenError(envelope.error) }, 400);

    // Event-volume rate limit (separate budget from the per-request limit): a single POST
    // can carry up to 1000 events, so meter the actual (raw) event count — invalid events
    // still consume budget.
    const { limit: evLimit, window: evWindow } = ingestRateLimitConfig();
    const ev = await checkRateLimit(
      `ingest-events:${c.get("projectId")}`,
      evLimit,
      evWindow,
      envelope.data.batch.length,
    );
    if (!ev.allowed) {
      c.header("Retry-After", String(ev.resetSeconds));
      return c.json({ error: "ingest event rate limit exceeded", limit: ev.limit, retryAfter: ev.resetSeconds }, 429);
    }

    const valid: IngestEvent[] = [];
    const errors: IngestResult[] = [];
    envelope.data.batch.forEach((raw, index) => {
      const parsed = ingestEvent.safeParse(raw);
      if (parsed.success) {
        valid.push(parsed.data);
        return;
      }
      const id = typeof (raw as { id?: unknown } | null)?.id === "string" ? (raw as { id: string }).id : "";
      const issue = parsed.error.issues[0];
      const error = (issue ? `${issue.path.join(".") || "event"}: ${issue.message}` : "invalid event").slice(0, 500);
      errors.push({ id, index, status: 400, error });
    });

    // Only valid events are persisted + enqueued: the blob stays a strictly-valid,
    // replayable log (the worker and DLQ replay parse it with ingestRequest.parse).
    if (valid.length > 0) await submitBatch(c.get("projectId"), { batch: valid });
    if (errors.length > 0) {
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "ingest events rejected",
          projectId: c.get("projectId"),
          rejected: errors.length,
          firstError: errors[0]?.error,
        }),
      );
    }
    const successes: IngestResult[] = valid.map((e) => ({ id: e.id, status: 201 }));
    return c.json({ successes, errors }, 207);
  },
);

// ── OTel OTLP/HTTP receiver (JSON + protobuf, GenAI semconv) ─────────────────────
// Plain route (not OpenAPI) so we can switch parsing on content-type: application/json
// or application/x-protobuf (the default OTLP/HTTP encoding). Auth/rate-limit are applied
// by the /v1/otel/* + /v1/* middleware above.
app.post("/v1/otel/v1/traces", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let payload: ReturnType<typeof decodeOtlpTraces> | null = null;

  if (contentType.includes("json")) {
    payload = (await c.req.json().catch(() => null)) as typeof payload;
  } else if (contentType.includes("protobuf")) {
    try {
      payload = decodeOtlpTraces(new Uint8Array(await c.req.arrayBuffer()));
    } catch {
      return c.json({ error: "could not decode OTLP protobuf" }, 400);
    }
  } else {
    return c.json({ error: "content-type must be application/json or application/x-protobuf" }, 415);
  }

  const events = otlpToEvents(payload ?? {});
  if (events.length > 0) {
    const parsed = ingestRequest.safeParse({ batch: events });
    if (!parsed.success) return c.json({ error: "mapping failed" }, 400);
    await submitBatch(c.get("projectId"), parsed.data);
  }

  // OTLP success: an empty ExportTraceServiceResponse. For protobuf, an empty body is a
  // valid "all accepted" response; for JSON we return the partialSuccess envelope.
  if (contentType.includes("protobuf")) {
    return c.body(new Uint8Array(0).buffer, 200, { "content-type": "application/x-protobuf" });
  }
  return c.json({ partialSuccess: {} }, 200);
});

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
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(500).optional(),
        userId: z.string().optional(),
        sessionId: z.string().optional(),
        environment: z.string().optional(),
        search: z.string().optional(),
        tag: z.string().optional(),
        promptId: z.string().optional(),
        scoreName: z.string().optional(),
        level: z.string().optional(),
        days: z.coerce.number().int().min(1).max(365).optional(),
      }),
    },
    responses: {
      200: { description: "Trace page", content: { "application/json": { schema: C.tracePage } } },
    },
  }),
  async (c) => {
    const { limit, page, pageSize, userId, sessionId, environment, search, tag, promptId, scoreName, level, days } =
      c.req.valid("query");
    // `page`/`pageSize` drive pagination; `limit` stays as a legacy single-page cap (e.g. session view).
    const size = pageSize ?? limit ?? 50;
    const offset = page ? (page - 1) * size : 0;
    const base = { userId, sessionId, environment, search, tag, promptId, scoreName, level, days };
    const [data, total] = await Promise.all([
      listTraces(c.get("projectId"), { ...base, limit: size, offset }),
      countTraces(c.get("projectId"), base),
    ]);
    // Attach each trace's scores (eval/annotation quality) so the list can show them at a glance.
    const scores: Record<string, { name: string; value: number | null; string_value: string }[]> = {};
    if (data.length) {
      const scoreMap = await getScoresByTraceIds(
        c.get("projectId"),
        data.map((t) => t.id),
      );
      for (const [traceId, arr] of scoreMap) {
        scores[traceId] = arr.map((s) => ({ name: s.name, value: s.value, string_value: s.string_value }));
      }
    }
    return c.json({ data, total, scores });
  },
);

// Registered before /v1/traces/{id} so the static segment resolves ahead of the param route.
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/traces/facets",
    summary: "Distinct filter facet values + counts for traces (environment / name / tags / scores)",
    tags: ["traces"],
    security,
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        // Active filters — counts are facet-excluding (each dimension ignores its own filter).
        environment: z.string().optional(),
        search: z.string().optional(),
        userId: z.string().optional(),
        tag: z.string().optional(),
        scoreName: z.string().optional(),
        level: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Trace facets", content: { "application/json": { schema: C.traceFacets } } },
    },
  }),
  async (c) => {
    const { days, limit, environment, search, userId, tag, scoreName, level } = c.req.valid("query");
    const data = await traceFacets(c.get("projectId"), {
      days,
      limit,
      environment,
      search,
      userId,
      tag,
      scoreName,
      level,
    });
    return c.json(data);
  },
);

// Registered before /v1/traces/{id} so the static segment resolves ahead of the param route.
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/traces/histogram",
    summary: "Trace volume bucketed by hour/day over the range (honors the trace-list filters)",
    tags: ["traces"],
    security,
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional(),
        environment: z.string().optional(),
        search: z.string().optional(),
        userId: z.string().optional(),
        tag: z.string().optional(),
        scoreName: z.string().optional(),
        level: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Trace volume histogram", content: { "application/json": { schema: C.traceHistogram } } },
    },
  }),
  async (c) => {
    const { days, environment, search, userId, tag, scoreName, level } = c.req.valid("query");
    const data = await traceHistogram(c.get("projectId"), {
      days,
      environment,
      search,
      userId,
      tag,
      scoreName,
      level,
    });
    return c.json(data);
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
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(500).optional(),
        days: z.coerce.number().int().min(1).max(365).optional(),
        search: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Session page", content: { "application/json": { schema: C.sessionPage } } },
    },
  }),
  async (c) => {
    const { limit, page, pageSize, days, search } = c.req.valid("query");
    const size = pageSize ?? limit ?? 50;
    const offset = page ? (page - 1) * size : 0;
    const [data, total] = await Promise.all([
      listSessions(c.get("projectId"), { limit: size, offset, days, search }),
      countSessions(c.get("projectId"), days, search),
    ]);
    return c.json({ data, total });
  },
);

// ── Users ────────────────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/users",
    summary: "List end users (traces grouped by user_id)",
    tags: ["traces"],
    security,
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(500).optional(),
        days: z.coerce.number().int().min(1).max(365).optional(),
        search: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "User page", content: { "application/json": { schema: C.userPage } } },
    },
  }),
  async (c) => {
    const { limit, page, pageSize, days, search } = c.req.valid("query");
    const size = pageSize ?? limit ?? 50;
    const offset = page ? (page - 1) * size : 0;
    const [data, total] = await Promise.all([
      listUsers(c.get("projectId"), { limit: size, offset, days, search }),
      countUsers(c.get("projectId"), days, search),
    ]);
    return c.json({ data, total });
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

// ── Replay a trace through the LLM gateway ───────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/v1/traces/{id}/replay",
    summary: "Re-run a stored trace's input through the LLM gateway and record the result as a new trace",
    tags: ["traces"],
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              provider: z.string().optional(),
              model: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Replay result", content: { "application/json": { schema: C.playgroundResponse } } },
      400: { description: "Gateway error" },
      403: { description: "Forbidden" },
      404: { description: "Trace not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    try {
      const result = await replayTrace(c.get("projectId"), id, body);
      if (!result) return c.json({ error: "trace not found" }, 404);
      await recordAudit(c.get("projectId"), c.get("actor"), "trace.replay", `trace:${id}`);
      return c.json(result, 200);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", scope: "trace.replay", message: String(err) }));
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
    }
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/traces/{id}/annotate",
    summary: "Annotate a trace with a manual ANNOTATION score (name + value/category + comment)",
    tags: ["traces"],
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]).default("NUMERIC"),
              value: z.number().optional(),
              stringValue: z.string().optional(),
              comment: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Annotation recorded", content: { "application/json": { schema: C.annotationResult } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const result = await annotateTrace(c.get("projectId"), id, body);
    await recordAudit(c.get("projectId"), c.get("actor"), "trace.annotate", `trace:${id}`, { score: body.name });
    return c.json(result, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/traces/{id}/tags",
    summary: "Replace a trace's tags",
    tags: ["traces"],
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ tags: z.array(z.string()) }) } } },
    },
    responses: {
      200: { description: "Updated tags", content: { "application/json": { schema: C.traceTags } } },
      403: { description: "Forbidden" },
      404: { description: "Trace not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const id = c.req.valid("param").id;
    const result = await setTraceTags(c.get("projectId"), id, c.req.valid("json").tags);
    if (!result) return c.json({ error: "trace not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "trace.tags", `trace:${id}`);
    return c.json(result, 200);
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

// ── Datasets: experiment comparison (items × runs) ───────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{name}/comparison",
    summary: "Compare a dataset's runs side by side (per-item output + scores)",
    tags: ["datasets"],
    security,
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: { description: "Comparison", content: { "application/json": { schema: C.experimentComparison } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const result = await getDatasetComparison(c.get("projectId"), c.req.valid("param").name);
    if (!result) return c.json({ error: "dataset not found" }, 404);
    return c.json(result);
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
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const name = c.req.valid("param").name;
    const items = c.req.valid("json").items as Parameters<typeof addDatasetItems>[2];
    const result = await addDatasetItems(c.get("projectId"), name, items);
    if (!result) return c.json({ error: "dataset not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "dataset.items.add", `dataset:${name}`, {
      count: items.length,
    });
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
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const name = c.req.valid("param").name;
    const body = c.req.valid("json");
    const result = await recordRun(c.get("projectId"), name, body.runName, body.links);
    if (!result) return c.json({ error: "dataset not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "dataset.run.record", `dataset:${name}`, {
      run: body.runName,
    });
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
              tools: z
                .array(
                  z.object({
                    name: z.string(),
                    description: z.string().optional(),
                    parameters: z.record(z.string(), z.any()),
                  }),
                )
                .optional(),
              responseFormat: z
                .object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.any()) })
                .optional(),
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
      console.error(JSON.stringify({ level: "error", scope: "playground.run", message: String(err) }));
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

// Static `/analytics` path — registered before any `/v1/evaluators/{name}/...`
// param route so it is never shadowed by a path-param match.
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/evaluators/analytics",
    summary: "Evaluator score trends (per-evaluator avg + count, plus daily trend)",
    tags: ["evaluators"],
    security,
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }) },
    responses: {
      200: { description: "Evaluator analytics", content: { "application/json": { schema: C.evaluatorAnalytics } } },
    },
  }),
  async (c) => {
    const data = await getEvaluatorAnalytics(c.get("projectId"), c.req.valid("query").days ?? 30);
    return c.json(data);
  },
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
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const name = c.req.valid("param").name;
    const result = await runEvaluator(c.get("projectId"), name, c.req.valid("json"));
    if (!result) return c.json({ error: "evaluator not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "evaluator.run", `evaluator:${name}`);
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
      data: [{ id: c.get("projectId"), name: "(api-key project)", slug: "", organization: "", role: c.get("role") }],
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

// Static `/analytics` path — registered before the `/v1/review-queues/{name}/...`
// param routes so it resolves to this handler, not a queue-name match.
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/review-queues/analytics",
    summary: "Review-queue throughput (per-queue pending/done/skipped totals)",
    tags: ["review"],
    security,
    responses: {
      200: { description: "Review analytics", content: { "application/json": { schema: C.reviewAnalytics } } },
    },
  }),
  async (c) => c.json(await getReviewAnalytics(c.get("projectId"))),
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
    const name = c.req.valid("param").name;
    const traceIds = c.req.valid("json").traceIds;
    const result = await addReviewItems(c.get("projectId"), name, traceIds);
    if (!result) return c.json({ error: "queue not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "review.items.add", `queue:${name}`, {
      count: traceIds.length,
    });
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
      query: z.object({
        status: z.enum(["PENDING", "DONE", "SKIPPED"]).optional(),
        assignee: z.string().optional(), // a user id, or "me" for the current user
      }),
    },
    responses: {
      200: { description: "Items", content: { "application/json": { schema: C.reviewItemsResponse } } },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const { status, assignee } = c.req.valid("query");
    const assigneeId = assignee === "me" ? c.get("userId") : assignee;
    const result = await listReviewItems(
      c.get("projectId"),
      c.req.valid("param").name,
      status ?? "PENDING",
      assigneeId,
    );
    if (!result) return c.json({ error: "queue not found" }, 404);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/review-queues/{name}/items/{itemId}/assign",
    summary: "Assign a review item to a user (empty assigneeId unassigns; defaults to self)",
    tags: ["review"],
    security,
    request: {
      params: z.object({ name: z.string(), itemId: z.string() }),
      body: { content: { "application/json": { schema: z.object({ assigneeId: z.string().optional() }) } } },
    },
    responses: {
      200: { description: "Assigned", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const { name, itemId } = c.req.valid("param");
    const assigneeId = c.req.valid("json").assigneeId ?? c.get("userId");
    const result = await assignReviewItem(c.get("projectId"), name, itemId, assigneeId);
    if (!result) return c.json({ error: "queue or item not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "review.assign", `item:${itemId}`, { assigneeId });
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
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const { name, itemId } = c.req.valid("param");
    const result = await submitReviewScore(c.get("projectId"), name, itemId, c.req.valid("json"));
    if (!result) return c.json({ error: "queue or item not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "review.score", `trace:${result.traceId}`, { score: name });
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/review-queues/{name}/items/{itemId}/skip",
    summary: "Skip a review item without scoring it (marks it SKIPPED)",
    tags: ["review"],
    security,
    request: {
      params: z.object({ name: z.string(), itemId: z.string() }),
    },
    responses: {
      200: { description: "Skipped", content: { "application/json": { schema: z.any() } } },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const { name, itemId } = c.req.valid("param");
    const result = await skipReviewItem(c.get("projectId"), name, itemId);
    if (!result) return c.json({ error: "queue or item not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "review.skip", `item:${itemId}`, { queue: name });
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
      400: { description: "Invalid or disallowed URL" },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    try {
      await assertPublicUrl(body.url);
    } catch {
      return c.json({ error: "url must be a public https endpoint (private/loopback targets are blocked)" }, 400);
    }
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
    const id = c.req.valid("param").id;
    const result = await deleteWidget(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "widget.delete", id);
    return c.json(result);
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
    const id = c.req.valid("param").id;
    const result = await deleteScoreConfig(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "score-config.delete", id);
    return c.json(result);
  },
);

// ── Score correction / deletion ──────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/v1/scores/{id}",
    summary: "Correct a score (insert a replacement row; ReplacingMergeTree keeps the latest event_ts)",
    tags: ["evaluators"],
    security,
    request: {
      params: z.object({ id: z.string() }),
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
      200: { description: "Corrected score", content: { "application/json": { schema: C.scoreCorrected } } },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const id = c.req.valid("param").id;
    const result = await correctScore(c.get("projectId"), id, c.req.valid("json"));
    if (!result) return c.json({ error: "score not found" }, 404);
    await recordAudit(c.get("projectId"), c.get("actor"), "score.correct", `score:${id}`);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/scores/{id}",
    summary: "Hard-delete a score (scoped to the active project)",
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
    const id = c.req.valid("param").id;
    const result = await deleteScore(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "score.delete", `score:${id}`);
    return c.json(result);
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
    const result = await createComment(c.get("projectId"), c.get("actor"), c.req.valid("json"));
    await recordAudit(c.get("projectId"), c.get("actor"), "comment.create", `${result.objectType}:${result.objectId}`);
    return c.json(result, 201);
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
    const id = c.req.valid("param").id;
    const result = await deleteComment(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "comment.delete", id);
    return c.json(result);
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
    const id = c.req.valid("param").id;
    const result = await deleteSavedView(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "saved-view.delete", id);
    return c.json(result);
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
    const id = c.req.valid("param").id;
    const result = await deleteModelPrice(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "model-price.delete", id);
    return c.json(result);
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
      400: { description: "Invalid or disallowed target URL" },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    try {
      await assertPublicUrl(body.target);
    } catch {
      return c.json({ error: "target must be a public https endpoint (private/loopback targets are blocked)" }, 400);
    }
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
    const id = c.req.valid("param").id;
    const result = await deleteAutomation(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "automation.delete", id);
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/v1/analytics-sink",
    summary: "Get the project's event sink (CDP forwarding) config",
    tags: ["platform"],
    security,
    responses: { 200: { description: "Config", content: { "application/json": { schema: C.analyticsSink } } } },
  }),
  async (c) => c.json(await getAnalyticsSink(c.get("projectId"))),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/analytics-sink",
    summary: "Configure forwarding trace/score events to a product-analytics sink / CDP",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean().optional(),
              host: z.string().url().optional(),
              apiKey: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: C.analyticsSink } } },
      400: { description: "Invalid or disallowed host URL" },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const body = c.req.valid("json");
    if (body.host) {
      try {
        await assertPublicUrl(body.host);
      } catch {
        return c.json({ error: "host must be a public https endpoint (private/loopback targets are blocked)" }, 400);
      }
    }
    const result = await setAnalyticsSink(c.get("projectId"), body);
    await recordAudit(c.get("projectId"), c.get("actor"), "analytics-sink.set", `enabled:${result.enabled}`);
    return c.json(result);
  },
);

// ── PII masking policy ───────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/masking",
    summary: "Get the project's PII masking policy (+ the available built-in patterns)",
    tags: ["platform"],
    security,
    responses: { 200: { description: "Policy", content: { "application/json": { schema: C.maskingPolicy } } } },
  }),
  async (c) => c.json(await getMaskingPolicy(c.get("projectId"))),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/masking",
    summary: "Configure PII redaction applied to trace input/output at ingest",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean().optional(),
              builtins: z.array(z.string()).optional(),
              customPatterns: z.array(z.string()).optional(),
              redactWith: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: C.maskingPolicy } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const result = await setMaskingPolicy(c.get("projectId"), c.req.valid("json"));
    await recordAudit(c.get("projectId"), c.get("actor"), "masking.set", `enabled:${result.enabled}`);
    return c.json(result);
  },
);

// ── API keys (project-scoped ingestion keys) ─────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/v1/api-keys",
    summary: "List the project's API keys (public key + hint; never the secret)",
    tags: ["platform"],
    security,
    responses: {
      200: { description: "API keys", content: { "application/json": { schema: C.listOf(C.apiKey) } } },
    },
  }),
  async (c) => c.json({ data: await listApiKeys(c.get("projectId")) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/v1/api-keys",
    summary: "Mint a new API key pair (the secret is returned once and never again)",
    tags: ["platform"],
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().optional(),
              scopes: z.array(z.enum(["read", "write", "ingest"])).optional(),
              expiresInDays: z.number().int().positive().nullable().optional(),
              rateLimitPerMinute: z.number().int().positive().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: C.apiKeyCreated } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const key = await createApiKey(c.get("projectId"), c.req.valid("json"));
    await recordAudit(c.get("projectId"), c.get("actor"), "api-key.create", key.publicKey, { scopes: key.scopes });
    return c.json(key, 201);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/v1/api-keys/{id}",
    summary: "Revoke an API key",
    tags: ["platform"],
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
      403: { description: "Forbidden" },
    },
  }),
  async (c) => {
    const denied = denyIfReadOnly(c);
    if (denied) return denied;
    const id = c.req.valid("param").id;
    const result = await revokeApiKey(c.get("projectId"), id);
    await recordAudit(c.get("projectId"), c.get("actor"), "api-key.revoke", id);
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
