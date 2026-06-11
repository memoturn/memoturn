// Streamable-HTTP transport tests: session lifecycle, bearer pinning, and
// upstream credential passthrough against a stub Memoturn node.
// Runs against the compiled output (`npm test` builds first).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// The stub Memoturn node must be configured before importing the server
// module (MEMOTURN_URL is read at module load).
const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    upstream.requests.push({
      path: req.url,
      authorization: req.headers.authorization ?? null,
      body: raw ? JSON.parse(raw) : null,
    });
    res.writeHead(200, { "content-type": "application/json", "Memoturn-Txid": "7" });
    res.end(JSON.stringify({ memories: [], txid: 7 }));
  });
});
upstream.requests = [];
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.MEMOTURN_URL = `http://127.0.0.1:${upstream.address().port}`;

const { serveHttp } = await import("../dist/server.js");

let mcp;
let base;
before(async () => {
  mcp = await serveHttp(0, "127.0.0.1");
  base = `http://127.0.0.1:${mcp.address().port}/mcp`;
});
after(() => {
  mcp.close();
  upstream.close();
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

async function rpc(body, { session, bearer } = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Streamable HTTP responds as SSE; extract the JSON-RPC payload.
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  return { res, data };
}

async function initialize(bearer) {
  const { res, data } = await rpc(INIT, { bearer });
  assert.equal(res.status, 200);
  assert.equal(data[0].result.serverInfo.name, "memoturn");
  const session = res.headers.get("mcp-session-id");
  assert.ok(session, "initialize returns a session id");
  // Complete the handshake.
  const ack = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(ack.status, 202);
  return session;
}

test("health answers without auth or session", async () => {
  const res = await fetch(base.replace("/mcp", "/health"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("initialize creates a session and tools are listed", async () => {
  const session = await initialize();
  const { res, data } = await rpc(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { session },
  );
  assert.equal(res.status, 200);
  const names = data[0].result.tools.map((t) => t.name);
  assert.ok(names.includes("memory_recall"));
  assert.ok(names.includes("memory_ask"));
});

test("requests without a session are rejected", async () => {
  const { res } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(res.status, 400);
});

test("unknown session id is a 404", async () => {
  const { res } = await rpc(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { session: "no-such-session" },
  );
  assert.equal(res.status, 404);
});

test("bearer is pinned to the session", async () => {
  const session = await initialize("token-a");
  const wrong = await rpc(
    { jsonrpc: "2.0", id: 5, method: "tools/list" },
    { session, bearer: "token-b" },
  );
  assert.equal(wrong.res.status, 401);
  const missing = await rpc(
    { jsonrpc: "2.0", id: 6, method: "tools/list" },
    { session },
  );
  assert.equal(missing.res.status, 401);
  const right = await rpc(
    { jsonrpc: "2.0", id: 7, method: "tools/list" },
    { session, bearer: "token-a" },
  );
  assert.equal(right.res.status, 200);
});

test("session bearer flows through to the Memoturn node", async () => {
  const session = await initialize("agent-jwt");
  upstream.requests.length = 0;
  const { data } = await rpc(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "memory_recall",
        arguments: { namespace: "acme", profile: "alice", query: "diet" },
      },
    },
    { session, bearer: "agent-jwt" },
  );
  assert.equal(data[0].result.isError ?? false, false);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].path, "/v1/memory/acme/alice/recall");
  assert.equal(upstream.requests[0].authorization, "Bearer agent-jwt");
});

test("memory_ingest applies MEMOTURN_SOURCE default and explicit source wins", async () => {
  const session = await initialize("agent-jwt");
  process.env.MEMOTURN_SOURCE = "claude-code";
  try {
    upstream.requests.length = 0;
    const { data } = await rpc(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "memory_ingest",
          arguments: {
            namespace: "acme",
            profile: "alice",
            memories: [
              { type: "fact", summary: "prefers dark mode", content: { v: 1 } },
              { type: "fact", summary: "uses zsh", content: { v: 2 }, source: "cursor" },
            ],
          },
        },
      },
      { session, bearer: "agent-jwt" },
    );
    assert.equal(data[0].result.isError ?? false, false);
    const sent = upstream.requests[0].body.memories;
    assert.equal(sent[0].source, "claude-code");
    assert.equal(sent[1].source, "cursor");
  } finally {
    delete process.env.MEMOTURN_SOURCE;
  }
});

test("memory_recall forwards the source filter", async () => {
  const session = await initialize("agent-jwt");
  upstream.requests.length = 0;
  const { data } = await rpc(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "memory_recall",
        arguments: { namespace: "acme", profile: "alice", query: "shell", source: "cursor" },
      },
    },
    { session, bearer: "agent-jwt" },
  );
  assert.equal(data[0].result.isError ?? false, false);
  assert.equal(upstream.requests[0].body.source, "cursor");
});
