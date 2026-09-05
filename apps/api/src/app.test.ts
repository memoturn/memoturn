import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { createApiKey } from "@memoturn/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "./app.js";

// Fault injection for the ingest write path: flip `blobFault.on` to make the blob store
// reject, the way an S3/MinIO outage would. Delegates to the real module otherwise.
const blobFault = vi.hoisted(() => ({ on: false }));
vi.mock("@memoturn/db/blob", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@memoturn/db/blob")>();
  return {
    ...mod,
    putRawBatch: (...args: Parameters<typeof mod.putRawBatch>) =>
      blobFault.on ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9000")) : mod.putRawBatch(...args),
  };
});

/**
 * HTTP-level tests against the Hono app via `app.request(...)` — they exercise the real
 * route surface, auth middleware, and scope gate the way a client would. The unauthenticated
 * + health checks run everywhere; the authenticated suite needs the datastores (API-key
 * auth caches in Redis, reads hit Doris) and is skipped otherwise, mirroring the
 * worker integration test. CI sets the env + service containers.
 */
const HAS_INFRA = Boolean(
  process.env.DATABASE_URL && process.env.DORIS_HOST && process.env.REDIS_URL && process.env.BLOB_ENDPOINT,
);

const basic = (pk: string, sk: string) => `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`;

describe("public + auth gating (no infra)", () => {
  it("GET /v1/health is public and reports the service", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "memoturn-api" });
  });

  it("rejects an unauthenticated request to a guarded route with 401", async () => {
    const res = await app.request("/v1/traces");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns a JSON 404 with a request id for an unknown path", async () => {
    const res = await app.request("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("not found");
    expect(body.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });

  it("echoes a well-formed inbound x-request-id and mints one otherwise", async () => {
    const echoed = await app.request("/v1/health", { headers: { "x-request-id": "proxy-abc.123" } });
    expect(echoed.headers.get("x-request-id")).toBe("proxy-abc.123");
    const minted = await app.request("/v1/health", { headers: { "x-request-id": "not valid: spaces & symbols!" } });
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("turns a body-limit HTTPException into the JSON error contract (413)", async () => {
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
      body: "x",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { requestId: string }).requestId).toBeTruthy();
  });
});

describe.skipIf(!HAS_INFRA)("authenticated /v1 routes (infra)", () => {
  const slug = `apitest-${Date.now()}`;
  let projectId = "";
  let full = { publicKey: "", secretKey: "", scopes: [] as string[] };
  let readOnly = { publicKey: "", secretKey: "" };
  const foreignSlug = `apitest-foreign-${Date.now()}`;
  let foreignProjectId = "";

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: slug, slug } });
    const project = await prisma.project.create({
      data: { name: slug, slug, organizationId: org.id },
    });
    projectId = project.id;
    full = await createApiKey(projectId, { name: "full" }); // default scopes: read+write+ingest
    readOnly = await createApiKey(projectId, { name: "read", scopes: ["read"] });

    // A second tenant with no shared membership — used to prove cross-project isolation.
    const foreignOrg = await prisma.organization.create({ data: { name: foreignSlug, slug: foreignSlug } });
    const foreignProject = await prisma.project.create({
      data: { name: foreignSlug, slug: foreignSlug, organizationId: foreignOrg.id },
    });
    foreignProjectId = foreignProject.id;
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await prisma.organization.delete({ where: { slug } }).catch(() => {});
    await prisma.project.delete({ where: { id: foreignProjectId } }).catch(() => {});
    await prisma.organization.delete({ where: { slug: foreignSlug } }).catch(() => {});
  });

  it("lists traces for a valid key and returns the contract envelope", async () => {
    const res = await app.request("/v1/traces", { headers: { authorization: basic(full.publicKey, full.secretKey) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("rejects a wrong secret with 401", async () => {
    const res = await app.request("/v1/traces", {
      headers: { authorization: basic(full.publicKey, "sk-mt-wrong") },
    });
    expect(res.status).toBe(401);
  });

  it("forbids ingest for a key lacking the 'ingest' scope (403)", async () => {
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(readOnly.publicKey, readOnly.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ batch: [] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("ingest");
  });

  it("accepts a batch from an ingest-scoped key with a 207 ack", async () => {
    const event = {
      id: `${slug}-evt`,
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: `${slug}-trace`, name: "apitest", environment: "test" },
    };
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ batch: [event] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { successes: unknown[]; errors: unknown[] };
    expect(body.successes).toHaveLength(1);
    expect(body.errors).toHaveLength(0);
  });

  it("answers 503 + Retry-After (JSON, with request id) when the blob store is down — never a bare 500", async () => {
    const event = {
      id: `${slug}-evt-outage`,
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: `${slug}-trace-outage`, name: "apitest", environment: "test" },
    };
    blobFault.on = true;
    try {
      const res = await app.request("/v1/ingest", {
        method: "POST",
        headers: {
          authorization: basic(full.publicKey, full.secretKey),
          "content-type": "application/json",
          "x-request-id": "sdk-retry-7",
        },
        body: JSON.stringify({ batch: [event] }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(res.headers.get("x-request-id")).toBe("sdk-retry-7");
      const body = (await res.json()) as { error: string; requestId: string; retryAfter: number };
      expect(body.requestId).toBe("sdk-retry-7");
      expect(body.retryAfter).toBe(5);
      expect(body.error).not.toContain("ECONNREFUSED"); // internals stay in the log
    } finally {
      blobFault.on = false;
    }
  });

  it("rejects a malformed batch with 400", async () => {
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ not: "a batch" }),
    });
    expect(res.status).toBe(400);
  });

  it("reports invalid events in the 207 errors array and still accepts the valid ones", async () => {
    const valid = {
      id: `${slug}-evt-ok`,
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: `${slug}-trace-ok`, name: "apitest", environment: "test" },
    };
    const invalid = { id: `${slug}-evt-bad`, type: "trace-create", timestamp: "not-a-date", body: {} };
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ batch: [valid, invalid] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      successes: { id: string; status: number }[];
      errors: { id: string; index?: number; status: number; error?: string }[];
    };
    expect(body.successes).toHaveLength(1);
    expect(body.successes[0]).toMatchObject({ id: valid.id, status: 201 });
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ id: invalid.id, index: 1, status: 400 });
    expect(body.errors[0]?.error).toBeTruthy();
  });

  it("returns 207 with no successes for an all-invalid batch", async () => {
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ batch: [{ type: "nope" }, 42] }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as { successes: unknown[]; errors: { id: string; index?: number }[] };
    expect(body.successes).toHaveLength(0);
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0]?.id).toBe(""); // no readable id on the rejected event
    expect(body.errors.map((e) => e.index)).toEqual([0, 1]);
  });

  // ── Privilege boundaries for API-key principals ─────────────────────────────────────
  // A default key (read+write+ingest) acts as MEMBER, never OWNER: it must not reach the
  // admin-only surfaces even though it can write. Only an explicit `admin` scope does.
  it("a default (non-admin) key cannot list, mint, or revoke API keys (403)", async () => {
    const auth = { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" };
    const list = await app.request("/v1/api-keys", { headers: auth });
    expect(list.status).toBe(403);
    const mint = await app.request("/v1/api-keys", { method: "POST", headers: auth, body: JSON.stringify({}) });
    expect(mint.status).toBe(403);
    const revoke = await app.request("/v1/api-keys/does-not-matter", { method: "DELETE", headers: auth });
    expect(revoke.status).toBe(403);
  });

  it("a default (non-admin) key cannot delete the project or change member roles (403)", async () => {
    const auth = { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" };
    const del = await app.request(`/v1/projects/${projectId}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(403);
    const member = await app.request(`/v1/projects/${projectId}/members/some-user`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ role: "owner" }),
    });
    expect(member.status).toBe(403);
    // And the project still exists.
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull();
  });

  it("an admin-scoped key can list the project's keys; `admin` is never granted by default", async () => {
    const admin = await createApiKey(projectId, { name: "admin", scopes: ["read", "write", "ingest", "admin"] });
    expect(full.scopes).not.toContain("admin");
    expect(admin.scopes).toContain("admin");
    const res = await app.request("/v1/api-keys", {
      headers: { authorization: basic(admin.publicKey, admin.secretKey) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { scopes: string[] }[] };
    expect(body.data.some((k) => k.scopes.includes("admin"))).toBe(true);
  });

  // ── Cost-bearing routes are write-gated ───────────────────────────────────────────────
  // The playground/assistant never mutate project data but spend the operator's provider
  // key. A read-only principal (a VIEWER, every public-demo sandbox visitor) must get 403,
  // not a completion — this is the guarantee `demo.ts` relies on.
  it("a read-only key cannot run the playground or the assistant (403)", async () => {
    const auth = { authorization: basic(readOnly.publicKey, readOnly.secretKey), "content-type": "application/json" };
    const body = JSON.stringify({ provider: "mock", model: "mock", messages: [{ role: "user", content: "hi" }] });
    for (const path of ["/v1/playground/chat", "/v1/playground/stream", "/v1/assistant/chat", "/v1/assistant/stream"]) {
      const res = await app.request(path, { method: "POST", headers: auth, body });
      expect(res.status, path).toBe(403);
    }
  });

  it("the streaming playground validates its body like the OpenAPI route (400 + maxTokens cap)", async () => {
    const auth = { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" };
    const empty = await app.request("/v1/playground/stream", { method: "POST", headers: auth, body: "{}" });
    expect(empty.status).toBe(400);
    const huge = await app.request("/v1/playground/stream", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        provider: "mock",
        model: "mock",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1e9,
      }),
    });
    expect(huge.status).toBe(400);
    const streamBad = await app.request("/v1/assistant/stream", { method: "POST", headers: auth, body: "not json" });
    expect(streamBad.status).toBe(400);
  });

  it("GET /ready reports every dependency and is 200 when they all answer", async () => {
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, { ok: boolean; ms: number }> };
    expect(body.status).toBe("ok");
    for (const dep of ["postgres", "redis", "telemetry", "blob"]) {
      expect(body.checks[dep]?.ok, dep).toBe(true);
      expect(typeof body.checks[dep]?.ms).toBe("number");
    }
  });

  it("GET /metrics renders Prometheus text when asked and JSON otherwise (token-gated)", async () => {
    const saved = process.env.API_METRICS_TOKEN;
    process.env.API_METRICS_TOKEN = "scrape-me";
    try {
      const noToken = await app.request("/metrics");
      expect(noToken.status).toBe(401);
      const json = await app.request("/metrics", { headers: { authorization: "Bearer scrape-me" } });
      expect(json.headers.get("content-type")).toContain("application/json");
      expect((await json.json()) as { requestsTotal: number }).toHaveProperty("requestsTotal");
      const prom = await app.request("/metrics", {
        headers: { authorization: "Bearer scrape-me", accept: "text/plain;version=0.0.4" },
      });
      expect(prom.status).toBe(200);
      expect(prom.headers.get("content-type")).toContain("text/plain; version=0.0.4");
      const text = await prom.text();
      expect(text).toMatch(/^# TYPE memoturn_api_requests_total counter$/m);
      expect(text).toMatch(/^memoturn_api_requests_total \d+$/m);
      expect(text).toMatch(/memoturn_api_route_latency_ms\{method="GET",route="\/v1\/traces",quantile="0.95"\} \d+/);
    } finally {
      if (saved === undefined) delete process.env.API_METRICS_TOKEN;
      else process.env.API_METRICS_TOKEN = saved;
    }
  });

  it("caps concurrent SSE streams per project (429) and frees the slot when a stream aborts", async () => {
    const saved = process.env.SSE_MAX_STREAMS_PER_PROJECT;
    process.env.SSE_MAX_STREAMS_PER_PROJECT = "1";
    await redisConnection().del(`memoturn:sse:${projectId}`);
    const headers = { authorization: basic(full.publicKey, full.secretKey) };
    try {
      const first = await app.request("/v1/live/traces", { headers });
      expect(first.status).toBe(200);
      const second = await app.request("/v1/live/traces", { headers });
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: string }).error).toContain("too many concurrent streams");
      // A client disconnect surfaces as the response body being cancelled (that is what
      // Bun.serve does) — Hono then fires onAbort, which releases the slot.
      await first.body?.cancel();
      await new Promise((r) => setTimeout(r, 50));
      const third = await app.request("/v1/live/traces", { headers });
      expect(third.status).toBe(200);
      await third.body?.cancel();
    } finally {
      if (saved === undefined) delete process.env.SSE_MAX_STREAMS_PER_PROJECT;
      else process.env.SSE_MAX_STREAMS_PER_PROJECT = saved;
      await redisConnection().del(`memoturn:sse:${projectId}`);
    }
  });

  it("rejects an MCP call to another tenant's project with a key scoped to this one (401)", async () => {
    const res = await app.request(`/v1/mcp/${foreignProjectId}`, {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
