import { StreamableHTTPTransport } from "@hono/mcp";
import { authenticateKeys, parseBasicAuth, recordAudit, tools } from "@memoturn/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";

/**
 * Remote Streamable-HTTP MCP endpoint, scoped to one project by URL:
 *
 *   POST|GET|DELETE /v1/mcp/:projectId
 *
 * Each project is its own MCP "resource" (RFC 8707), so a client connects per-project.
 * Transport is @hono/mcp's StreamableHTTPTransport (the SDK's own transport is Node
 * req/res; this app is Hono-on-Bun / Fetch). Stateless — a fresh Server + transport per
 * request (no sessionIdGenerator) so any API replica can serve any call.
 *
 * Auth (PR1): API-key Basic auth (`pk-mt-…:sk-mt-…`), and the key must belong to the
 * project in the URL. memoturn cloud will add a Better Auth OAuth branch in resolveMcpAuth
 * (bearer token -> getMcpSession -> getUserProjectAccess) without touching the tool path.
 *
 * RBAC is per-tool, not per-HTTP-method: every tool call is a POST, so the method-based
 * scope gate used elsewhere can't distinguish reads from writes. We map the tool's `write`
 * flag to the required scope (`write` vs `read`) inside the call handler.
 */
interface McpAuth {
  projectId: string;
  scopes: string[];
  actor: string;
}

async function resolveMcpAuth(c: Context, projectId: string): Promise<McpAuth | null> {
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (!creds) return null;
  const ctx = await authenticateKeys(creds.publicKey, creds.secretKey);
  // The key must be scoped to the project named in the resource URL.
  if (!ctx || ctx.projectId !== projectId) return null;
  return { projectId, scopes: ctx.scopes, actor: `apikey:${creds.publicKey}` };
}

function buildServer(auth: McpAuth): Server {
  const server = new Server({ name: "memoturn", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };

    const need = tool.write ? "write" : "read";
    if (!auth.scopes.includes(need)) {
      return {
        isError: true,
        content: [{ type: "text", text: `error: forbidden — API key lacks the '${need}' scope` }],
      };
    }
    try {
      const result = await tool.handler(auth.projectId, req.params.arguments ?? {});
      if (tool.write) await recordAudit(auth.projectId, auth.actor, `mcp.${tool.name}`, req.params.name);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `error: ${message}` }] };
    }
  });

  return server;
}

export async function handleMcp(c: Context): Promise<Response> {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.json({ error: "missing project id" }, 404);
  const auth = await resolveMcpAuth(c, projectId);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Basic realm="memoturn-mcp"' });
  }

  const server = buildServer(auth);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.body(null, 204);
}
