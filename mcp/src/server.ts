/**
 * Memoturn MCP server core: tool definitions + transports.
 *
 * Agents are first-class database clients: provision a database per
 * agent/session, store documents/KV/vectors/conversation memory, and use
 * burner branches for fork-test-rewind experimentation
 * (docs/architecture/06-mcp-and-assistant.md).
 *
 * Two transports over the same tool set:
 * - stdio (local dev): credentials come from the environment.
 * - streamable HTTP (remote/production): credentials come from the
 *   `Authorization: Bearer` header of the initialize request and are pinned
 *   to the MCP session — every later request must present the same bearer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const BASE = process.env.MEMOTURN_URL ?? "http://127.0.0.1:8080";

export interface Creds {
  /** Per-database / namespace JWT (agent posture). */
  token?: string;
  /** Platform key (orchestrator posture: provision, list). */
  platformKey?: string;
}

export function envCreds(): Creds {
  return {
    token: process.env.MEMOTURN_TOKEN,
    platformKey: process.env.MEMOTURN_PLATFORM_KEY,
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Build a Memoturn MCP server whose tools call the node as `creds`. */
export function buildServer(creds: Creds): McpServer {
  function authHeaders(platform = false): Record<string, string> {
    const cred = platform
      ? (creds.platformKey ?? creds.token)
      : (creds.token ?? creds.platformKey);
    return cred ? { authorization: `Bearer ${cred}` } : {};
  }

  async function api(method: string, path: string, body?: unknown, platform = false): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...authHeaders(platform),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new Error(`Memoturn ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
    }
    return { txid: res.headers.get("Memoturn-Txid"), result: parsed };
  }

  const server = new McpServer({ name: "memoturn", version: "0.1.0" });

  const dbSpec = z
    .string()
    .describe("Database spec `name` or `name@branch` (`@main` implicit)");

  server.tool(
    "provision_database",
    "Create a new Memoturn database (instant, metadata-only). Give each agent or session its own.",
    { name: z.string().describe("Database name, e.g. agent-42") },
    async ({ name }) => ok(await api("POST", "/v1/databases", { name }, true)),
  );

  server.tool("list_databases", "List databases on this Memoturn node.", {}, async () =>
    ok(await api("GET", "/v1/databases", undefined, true)),
  );

  server.tool(
    "query",
    "Run SQL statements (atomic batch) against a database. The escape hatch — prefer docs/kv/memory tools.",
    {
      db: dbSpec,
      stmts: z
        .array(z.object({ q: z.string(), params: z.array(z.any()).optional() }))
        .describe("Statements with optional bound params"),
    },
    async ({ db, stmts }) => ok(await api("POST", `/v1/db/${db}/sql`, { stmts })),
  );

  server.tool(
    "docs_insert",
    "Insert JSON documents into a collection (created lazily; _id assigned if missing).",
    { db: dbSpec, collection: z.string(), docs: z.array(z.record(z.any())) },
    async ({ db, collection, docs }) =>
      ok(await api("POST", `/v1/db/${db}/docs/${collection}/insert`, { docs })),
  );

  server.tool(
    "docs_find",
    "Find documents with a Mongo-style filter ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/$and/$or/$not).",
    {
      db: dbSpec,
      collection: z.string(),
      filter: z.record(z.any()).optional(),
      sort: z.record(z.number()).optional(),
      limit: z.number().optional(),
    },
    async ({ db, collection, filter, sort, limit }) =>
      ok(await api("POST", `/v1/db/${db}/docs/${collection}/find`, { filter: filter ?? {}, sort, limit })),
  );

  server.tool(
    "docs_update",
    "Update documents with operators ($set/$unset/$inc/$push).",
    {
      db: dbSpec,
      collection: z.string(),
      filter: z.record(z.any()),
      update: z.record(z.any()),
      multi: z.boolean().optional(),
    },
    async ({ db, collection, filter, update, multi }) =>
      ok(await api("POST", `/v1/db/${db}/docs/${collection}/update`, { filter, update, multi })),
  );

  server.tool(
    "kv_put",
    "Put a value into a KV namespace (optional TTL seconds). Use for scratchpads, flags, caches.",
    { db: dbSpec, ns: z.string(), key: z.string(), value: z.string(), ttl: z.number().optional() },
    async ({ db, ns, key, value, ttl }) => {
      const qs = ttl !== undefined ? `?ttl=${ttl}` : "";
      const res = await fetch(`${BASE}/v1/db/${db}/kv/${ns}/${encodeURIComponent(key)}${qs}`, {
        method: "PUT",
        headers: authHeaders(),
        body: value,
      });
      if (!res.ok) throw new Error(`Memoturn ${res.status}: ${await res.text()}`);
      return ok({ txid: res.headers.get("Memoturn-Txid") });
    },
  );

  server.tool(
    "kv_get",
    "Get a value from a KV namespace.",
    { db: dbSpec, ns: z.string(), key: z.string() },
    async ({ db, ns, key }) => {
      const res = await fetch(`${BASE}/v1/db/${db}/kv/${ns}/${encodeURIComponent(key)}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) return ok({ found: false });
      if (!res.ok) throw new Error(`Memoturn ${res.status}: ${await res.text()}`);
      return ok({ found: true, value: await res.text(), txid: res.headers.get("Memoturn-Txid") });
    },
  );

  server.tool(
    "vector_upsert",
    "Store an embedding under an id in a vector collection (ANN-indexed).",
    { db: dbSpec, collection: z.string(), id: z.string(), embedding: z.array(z.number()) },
    async ({ db, collection, id, embedding }) =>
      ok(await api("POST", `/v1/db/${db}/vectors/${collection}`, { id, embedding })),
  );

  server.tool(
    "vector_search",
    "ANN search a vector collection; returns nearest ids with cosine distance.",
    { db: dbSpec, collection: z.string(), vector: z.array(z.number()), k: z.number().optional() },
    async ({ db, collection, vector, k }) =>
      ok(await api("POST", `/v1/db/${db}/vectors/${collection}/search`, { vector, k })),
  );

  server.tool(
    "memory_append",
    "Append a conversation turn to a session (optional embedding for semantic recall).",
    {
      db: dbSpec,
      session: z.string(),
      role: z.string(),
      content: z.record(z.any()),
      embedding: z.array(z.number()).optional(),
    },
    async ({ db, session, role, content, embedding }) =>
      ok(await api("POST", `/v1/db/${db}/memory/${session}/turns`, { role, content, embedding })),
  );

  server.tool(
    "memory_window",
    "Fetch the last N turns of a session in order.",
    { db: dbSpec, session: z.string(), last: z.number().optional() },
    async ({ db, session, last }) =>
      ok(await api("GET", `/v1/db/${db}/memory/${session}/turns?last=${last ?? 20}`)),
  );

  server.tool(
    "memory_search",
    "Semantic search over a session's embedded turns.",
    { db: dbSpec, session: z.string(), vector: z.array(z.number()), k: z.number().optional() },
    async ({ db, session, vector, k }) =>
      ok(await api("POST", `/v1/db/${db}/memory/${session}/search`, { vector, k })),
  );

  // ---- agent memory: namespace > profile > memory (docs/architecture/07) ----

  const namespace = z.string().describe("Memory namespace (app/env/tenant), e.g. acme");
  const profile = z
    .string()
    .describe("Memory profile — one isolated store per user/team/agent persona, e.g. user-alice");

  server.tool(
    "memory_ingest",
    "Store typed memories in a profile (idempotent batch). Types: fact/instruction (supersede older entries sharing topic_key), event (accumulates), task (session-scoped, expires). Extraction is yours: pass already-distilled memories, optionally with embeddings.",
    {
      namespace,
      profile,
      memories: z
        .array(
          z.object({
            type: z.enum(["fact", "event", "instruction", "task"]),
            topic_key: z.string().optional().describe("Supersession key for fact/instruction, e.g. user.dietary-preference"),
            summary: z.string().describe("One-line gist (keyword-searchable)"),
            content: z.record(z.any()).describe("Full memory payload"),
            keywords: z.string().optional().describe("Extra space-separated search terms"),
            embedding: z.array(z.number()).optional(),
            session_id: z.string().optional(),
            ttl: z.number().optional().describe("Task lifetime in seconds (default 86400)"),
          }),
        )
        .describe("Memories to store"),
    },
    async ({ namespace, profile, memories }) =>
      ok(await api("POST", `/v1/memory/${namespace}/${profile}/memories`, { memories })),
  );

  server.tool(
    "memory_recall",
    "Hybrid recall from a profile: keyword + topic + vector channels, rank-fused. Pass any of query (free text), embedding, topic_key. Empty result means nothing relevant — never pads.",
    {
      namespace,
      profile,
      query: z.string().optional(),
      embedding: z.array(z.number()).optional(),
      topic_key: z.string().optional(),
      types: z.array(z.enum(["fact", "event", "instruction", "task"])).optional(),
      k: z.number().optional(),
      include_superseded: z.boolean().optional(),
      include_turns: z
        .boolean()
        .optional()
        .describe("Also search the verbatim transcript (requires embedding); returns a separate turns array"),
    },
    async ({ namespace, profile, ...body }) =>
      ok(await api("POST", `/v1/memory/${namespace}/${profile}/recall`, body)),
  );

  server.tool(
    "memory_ask",
    "Ask a natural-language question over a profile's memories: hybrid recall, then the node's assistant synthesizes a prose answer citing the supporting memory ids. Errors with 503 when the node has no assistant configured — fall back to memory_recall and synthesize yourself.",
    {
      namespace,
      profile,
      question: z.string().describe("Natural-language question, e.g. 'what does the user eat?'"),
      k: z.number().optional().describe("Memories to recall as context (default 8)"),
      session_id: z.string().optional(),
    },
    async ({ namespace, profile, ...body }) =>
      ok(await api("POST", `/v1/memory/${namespace}/${profile}/ask`, body)),
  );

  server.tool(
    "memory_extract",
    "Distill raw conversation turns into typed memories with the node's server-side extractor, then ingest them (idempotent). Use dry_run to preview proposals without writing. Errors with 503 when the node has no extractor configured — fall back to memory_ingest with your own distilled memories.",
    {
      namespace,
      profile,
      turns: z
        .array(z.object({ role: z.string(), content: z.any() }))
        .describe("Raw conversation turns to distill"),
      session_id: z.string().optional(),
      dry_run: z.boolean().optional().describe("Propose without ingesting"),
    },
    async ({ namespace, profile, ...body }) =>
      ok(await api("POST", `/v1/memory/${namespace}/${profile}/extract`, body)),
  );

  server.tool(
    "memory_forget",
    "Permanently delete one memory from a profile (hard delete; supersession history normally preserves old memories without this).",
    { namespace, profile, id: z.string().describe("Memory id (mem_…)") },
    async ({ namespace, profile, id }) => {
      const res = await fetch(`${BASE}/v1/memory/${namespace}/${profile}/memories/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.status === 404) return ok({ forgotten: false });
      if (!res.ok) throw new Error(`Memoturn ${res.status}: ${await res.text()}`);
      return ok({ forgotten: true, txid: res.headers.get("Memoturn-Txid") });
    },
  );

  server.tool(
    "memory_get",
    "Fetch one memory from a profile by id, including its supersession state. Returns not-found rather than erroring when the id is unknown.",
    { namespace, profile, id: z.string().describe("Memory id (mem_…)") },
    async ({ namespace, profile, id }) => {
      const res = await fetch(`${BASE}/v1/memory/${namespace}/${profile}/memories/${id}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) return ok({ found: false });
      if (!res.ok) throw new Error(`Memoturn ${res.status}: ${await res.text()}`);
      return ok({ found: true, txid: res.headers.get("Memoturn-Txid"), memory: await res.json() });
    },
  );

  server.tool(
    "memory_sessions_list",
    "List recent sessions in a profile (most recent first). Useful before ending or inspecting a session.",
    { namespace, profile, limit: z.number().optional().describe("Max sessions (default 100)") },
    async ({ namespace, profile, limit }) => {
      const qs = limit !== undefined ? `?limit=${limit}` : "";
      return ok(await api("GET", `/v1/memory/${namespace}/${profile}/sessions${qs}`));
    },
  );

  server.tool(
    "memory_session_end",
    "End a session: its task memories expire immediately; durable fact/event/instruction memories survive. Set drop_turns to also delete the verbatim transcript.",
    {
      namespace,
      profile,
      session_id: z.string().describe("Session id to end"),
      drop_turns: z.boolean().optional().describe("Also delete the raw transcript for this session"),
    },
    async ({ namespace, profile, session_id, drop_turns }) => {
      const qs = drop_turns ? "?turns=true" : "";
      const res = await fetch(
        `${BASE}/v1/memory/${namespace}/${profile}/sessions/${session_id}${qs}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`Memoturn ${res.status}: ${await res.text()}`);
      return ok({ ended: true, txid: res.headers.get("Memoturn-Txid") });
    },
  );

  server.tool(
    "memory_profiles_list",
    "List the memory profiles under a namespace (each profile is one isolated store). Requires a namespace token.",
    { namespace },
    async ({ namespace }) => ok(await api("GET", `/v1/memory/${namespace}`)),
  );

  server.tool(
    "branch_create",
    "Fork the database copy-on-write. Set ttl for a burner branch (auto-incinerated) — fork, test risky changes, then promote or discard. Destructive ops never touch the parent.",
    { db: z.string().describe("Database name (forks from @main or `from`)"), name: z.string(), from: z.string().optional(), ttl: z.number().optional() },
    async ({ db, name, from, ttl }) =>
      ok(await api("POST", `/v1/db/${db}/branches`, { name, from, ttl })),
  );

  server.tool(
    "branch_checkpoint",
    "Name the current state of a branch so you can rewind to it.",
    { db: z.string(), branch: z.string().default("main"), name: z.string() },
    async ({ db, branch, name }) =>
      ok(await api("POST", `/v1/db/${db}/branches/${branch}/checkpoint`, { name })),
  );

  server.tool(
    "branch_rewind",
    "Rewind a branch to a checkpoint (destructive for state after the checkpoint).",
    { db: z.string(), branch: z.string().default("main"), to: z.string() },
    async ({ db, branch, to }) =>
      ok(await api("POST", `/v1/db/${db}/branches/${branch}/rewind`, { to })),
  );

  return server;
}

// ---- streamable HTTP transport (remote/production; docs/architecture/06) ----

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Bearer presented at initialize; pinned for the session's lifetime. */
  bearer?: string;
}

function bearerOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : undefined;
}

function deny(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Serve the MCP server over streamable HTTP at `/mcp`.
 *
 * Sessions are stateful: an initialize POST (no `mcp-session-id`) creates a
 * session whose upstream Memoturn credentials are the request's bearer token
 * (falling back to env credentials for unauthenticated local dev). The bearer
 * is pinned: every subsequent request on that session must present the same
 * one, so a session id alone never grants access to another caller's scope.
 */
export function serveHttp(port: number, host = "127.0.0.1"): Promise<HttpServer> {
  const sessions = new Map<string, Session>();

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      deny(res, 404, "not found (MCP endpoint is /mcp)");
      return;
    }
    try {
      const bearer = bearerOf(req);
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const session = sessions.get(sid);
        if (!session) {
          deny(res, 404, "unknown or expired mcp-session-id");
          return;
        }
        if (session.bearer !== bearer) {
          deny(res, 401, "bearer token does not match this session");
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        deny(res, 400, "missing mcp-session-id (initialize first)");
        return;
      }
      // New session: bind the caller's bearer to the upstream credentials.
      const creds: Creds = bearer ? { token: bearer, platformKey: bearer } : envCreds();
      const server = buildServer(creds);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, bearer });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) {
        deny(res, 500, e instanceof Error ? e.message : String(e));
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve(http));
  });
}
