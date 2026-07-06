import { StreamableHTTPTransport } from "@hono/mcp";
import {
  authenticateKeys,
  auth as betterAuth,
  checkRateLimit,
  getUserProjectAccess,
  mcpRateLimitConfig,
  parseBasicAuth,
  recordAudit,
  tools,
} from "@memoturn/server";
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
 * Two auth paths, both resolving to `{ projectId, actor, allows }` for the URL's project:
 *  1. API-key Basic (`pk-mt-…:sk-mt-…`, self-host / headless) — the key must belong to the
 *     project; `allows(need)` checks the key's scopes.
 *  2. Better Auth OAuth bearer (memoturn cloud IDE click-through) — the mcp() plugin's token
 *     resolves to a userId, then getUserProjectAccess authorizes that user for the project and
 *     yields a role; `allows(need)` = reads for any member, writes for non-VIEWER roles.
 *
 * RBAC is per-tool, not per-HTTP-method: every tool call is a POST, so a method-based scope
 * gate can't distinguish reads from writes. The tool's `write` flag drives `allows(need)`.
 */
interface McpAuth {
  projectId: string;
  actor: string;
  allows: (need: "read" | "write") => boolean;
}

async function resolveMcpAuth(c: Context, projectId: string): Promise<McpAuth | null> {
  // 1. API-key Basic auth — the key must be scoped to the project named in the resource URL.
  const creds = parseBasicAuth(c.req.header("authorization"));
  if (creds) {
    const ctx = await authenticateKeys(creds.publicKey, creds.secretKey);
    if (!ctx || ctx.projectId !== projectId) return null;
    return { projectId, actor: `apikey:${creds.publicKey}`, allows: (need) => ctx.scopes.includes(need) };
  }

  // 2. Better Auth OAuth bearer token -> user -> project membership + role.
  const token = await betterAuth.api.getMcpSession({ headers: c.req.raw.headers });
  if (token) {
    const access = await getUserProjectAccess(token.userId, projectId);
    if (access) {
      return {
        projectId,
        actor: `user:${token.userId}`,
        // Any member may read; only non-VIEWER roles may run write tools.
        allows: (need) => need === "read" || access.role !== "VIEWER",
      };
    }
  }

  return null;
}

function buildServer(mcpAuth: McpAuth): Server {
  const server = new Server({ name: "memoturn", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };

    const need = tool.write ? "write" : "read";
    if (!mcpAuth.allows(need)) {
      return {
        isError: true,
        content: [{ type: "text", text: `error: forbidden — the '${need}' permission is required` }],
      };
    }
    try {
      const result = await tool.handler(mcpAuth.projectId, req.params.arguments ?? {});
      if (tool.write) await recordAudit(mcpAuth.projectId, mcpAuth.actor, `mcp.${tool.name}`, req.params.name);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `error: ${message}` }] };
    }
  });

  return server;
}

/** Best-effort client IP for pre-auth throttling (behind Caddy, X-Forwarded-For is set). */
function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return c.req.header("x-real-ip")?.trim() || "unknown";
}

export async function handleMcp(c: Context): Promise<Response> {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.json({ error: "missing project id" }, 404);

  // Per-IP throttle BEFORE auth — this route sits ahead of the global rate limiter and runs
  // a credential lookup on every call, so it must not offer unauthenticated clients free tries.
  const { limit, window } = mcpRateLimitConfig();
  const rl = await checkRateLimit(`mcp:${clientIp(c)}`, limit, window);
  if (!rl.allowed) {
    return c.json({ error: "rate limited" }, 429, { "retry-after": String(rl.resetSeconds) });
  }

  const mcpAuth = await resolveMcpAuth(c, projectId);
  if (!mcpAuth) {
    // Advertise both auth schemes: Bearer points OAuth clients at the protected-resource
    // metadata (spec discovery); Basic is for programmatic clients holding an API key pair.
    const resourceMetadata = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
    return c.json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}", Basic realm="memoturn-mcp"`,
    });
  }

  const server = buildServer(mcpAuth);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.body(null, 204);
}
