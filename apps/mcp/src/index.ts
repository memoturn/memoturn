import { authenticateKeys, tools } from "@memoturn/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * memoturn MCP server — exposes prompts, datasets, and review queues as tools for
 * agent IDEs (Claude Desktop, Cursor, etc.) over stdio.
 *
 * Auth: set MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY (a project API key pair). The
 * server resolves them to a single project at startup and scopes every tool to it.
 *
 * NB: stdio MCP servers must keep stdout clean for the JSON-RPC stream — all logging
 * goes to stderr.
 */
const log = (...args: unknown[]) => console.error("[mcp]", ...args);

async function main() {
  const publicKey = process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = process.env.MEMOTURN_SECRET_KEY ?? "";
  if (!publicKey || !secretKey) {
    log("error: set MEMOTURN_PUBLIC_KEY and MEMOTURN_SECRET_KEY (a project API key pair)");
    process.exit(1);
  }

  const auth = await authenticateKeys(publicKey, secretKey);
  if (!auth) {
    log("error: invalid API key pair — could not resolve a project");
    process.exit(1);
  }
  const { projectId } = auth;

  const server = new Server({ name: "memoturn", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.handler(projectId, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `error: ${message}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${tools.length} tools, project ${projectId}`);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
