import { prisma } from "@memoturn/db";
import { createApiKey } from "@memoturn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app.js";

/**
 * HTTP-level tests against the Hono app via `app.request(...)` — they exercise the real
 * route surface, auth middleware, and scope gate the way a client would. The unauthenticated
 * + health checks run everywhere; the authenticated suite needs the datastores (API-key
 * auth caches in Redis, reads hit ClickHouse) and is skipped otherwise, mirroring the
 * worker integration test. CI sets the env + service containers.
 */
const HAS_INFRA = Boolean(
  process.env.DATABASE_URL && process.env.CLICKHOUSE_URL && process.env.REDIS_URL && process.env.BLOB_ENDPOINT,
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

  it("returns 404 for an unknown path", async () => {
    const res = await app.request("/v1/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!HAS_INFRA)("authenticated /v1 routes (infra)", () => {
  const slug = `apitest-${Date.now()}`;
  let projectId = "";
  let full = { publicKey: "", secretKey: "" };
  let readOnly = { publicKey: "", secretKey: "" };

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: slug, slug } });
    const project = await prisma.project.create({
      data: { name: slug, slug, organizationId: org.id },
    });
    projectId = project.id;
    full = await createApiKey(projectId, { name: "full" }); // default scopes: read+write+ingest
    readOnly = await createApiKey(projectId, { name: "read", scopes: ["read"] });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await prisma.organization.delete({ where: { slug } }).catch(() => {});
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

  it("rejects a malformed batch with 400", async () => {
    const res = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: basic(full.publicKey, full.secretKey), "content-type": "application/json" },
      body: JSON.stringify({ not: "a batch" }),
    });
    expect(res.status).toBe(400);
  });
});
