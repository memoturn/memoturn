import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { buildServer, clientIpFrom, type McpAuth } from "./mcp.js";

describe("clientIpFrom", () => {
  it("trusts nothing with no proxy declared (XFF is client-spoofable)", () => {
    expect(clientIpFrom("1.2.3.4", "5.6.7.8", 0)).toBe("unknown");
  });

  it("reads the real client from the end, ignoring a spoofed prefix (1 trusted proxy)", () => {
    expect(clientIpFrom("9.9.9.9", undefined, 1)).toBe("9.9.9.9");
    // Attacker prepends a fake IP; the trusted proxy appends the real peer to the right.
    expect(clientIpFrom("6.6.6.6, 9.9.9.9", undefined, 1)).toBe("9.9.9.9");
  });

  it("honors multiple trusted proxies", () => {
    expect(clientIpFrom("fake, 5.5.5.5, 8.8.8.8", undefined, 2)).toBe("5.5.5.5");
  });

  it("falls back to x-real-ip then unknown when trusted", () => {
    expect(clientIpFrom(undefined, "7.7.7.7", 1)).toBe("7.7.7.7");
    expect(clientIpFrom(undefined, undefined, 1)).toBe("unknown");
  });
});

/**
 * Protocol-level tests through the same createMcpHandler pipeline handleMcp uses, with a
 * stubbed McpAuth so no datastore is touched: tools/list, server/discover, RBAC denial,
 * and unknown-tool all resolve before any tool handler would hit the DB. handleMcp itself
 * (rate limit + credential resolution) needs Redis/Postgres and is covered by e2e.
 */
const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const auth = (overrides?: Partial<McpAuth>): McpAuth => ({
  projectId: "proj-test",
  actor: "apikey:pk-test",
  allows: () => true,
  ...overrides,
});

const handlerFor = (mcpAuth: McpAuth) => createMcpHandler(() => buildServer(mcpAuth), { legacy: "stateless" });

const modernRequest = (
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
) =>
  new Request("http://localhost/v1/mcp/proj-test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
  });

/** Final JSON-RPC message of a response, whether delivered as plain JSON or an SSE stream. */
async function lastMessage(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const events = (await res.text())
      .split("\n\n")
      .flatMap((block) => block.split("\n").filter((line) => line.startsWith("data:")))
      .map((line) => JSON.parse(line.slice(5)));
    return events[events.length - 1];
  }
  return (await res.json()) as Record<string, unknown>;
}

describe("MCP 2026-07-28 stateless protocol", () => {
  it("answers tools/list without any initialize handshake", async () => {
    const res = await handlerFor(auth()).fetch(modernRequest("tools/list"));
    expect(res.status).toBe(200);
    const msg = await lastMessage(res);
    const result = msg.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.map((t) => t.name)).toContain("query_traces");
  });

  it("implements server/discover with the modern revision", async () => {
    const res = await handlerFor(auth()).fetch(modernRequest("server/discover"));
    expect(res.status).toBe(200);
    const msg = await lastMessage(res);
    // Server identity travels in the result's _meta on 2026-07-28, not a top-level field.
    const result = msg.result as {
      supportedVersions: string[];
      _meta: { "io.modelcontextprotocol/serverInfo": { name: string } };
    };
    expect(result.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("memoturn");
  });

  it("denies a write tool to read-only auth at the tool layer", async () => {
    const readOnly = auth({ allows: (need) => need === "read" });
    const res = await handlerFor(readOnly).fetch(
      modernRequest(
        "tools/call",
        { name: "create_dataset", arguments: { name: "x" } },
        { "mcp-name": "create_dataset" },
      ),
    );
    expect(res.status).toBe(200);
    const msg = await lastMessage(res);
    const result = msg.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("'write' permission is required");
  });

  it("reports an unknown tool as a tool error, not a protocol error", async () => {
    const res = await handlerFor(auth()).fetch(
      modernRequest("tools/call", { name: "no_such_tool", arguments: {} }, { "mcp-name": "no_such_tool" }),
    );
    expect(res.status).toBe(200);
    const msg = await lastMessage(res);
    const result = msg.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown tool");
  });
});

describe("legacy (pre-2026) client compatibility", () => {
  it("still serves the initialize handshake statelessly", async () => {
    const res = await handlerFor(auth()).fetch(
      new Request("http://localhost/v1/mcp/proj-test", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy-test", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const msg = await lastMessage(res);
    const result = msg.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe("memoturn");
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  it("rejects legacy session operations (GET) — there are no sessions", async () => {
    const res = await handlerFor(auth()).fetch(
      new Request("http://localhost/v1/mcp/proj-test", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(res.status).toBe(405);
  });
});
