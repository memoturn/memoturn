#!/usr/bin/env node
/**
 * Memoturn MCP server entrypoint.
 *
 * Default: stdio transport (local dev), credentials from the environment.
 * Remote: `--http [port]` or MEMOTURN_MCP_PORT serves streamable HTTP at
 * /mcp, with per-session credentials from the Authorization header
 * (docs/architecture/06-mcp-and-assistant.md).
 *
 * Env: MEMOTURN_URL (default http://127.0.0.1:8080), MEMOTURN_TOKEN,
 * MEMOTURN_PLATFORM_KEY; HTTP mode: MEMOTURN_MCP_PORT,
 * MEMOTURN_MCP_HOST (default 127.0.0.1 — set 0.0.0.0 behind TLS/ingress).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, envCreds, serveHttp } from "./server.js";

const httpFlag = process.argv.indexOf("--http");
const portArg = httpFlag !== -1 ? process.argv[httpFlag + 1] : undefined;
const port =
  httpFlag !== -1
    ? Number(portArg && /^\d+$/.test(portArg) ? portArg : process.env.MEMOTURN_MCP_PORT ?? 8765)
    : process.env.MEMOTURN_MCP_PORT
      ? Number(process.env.MEMOTURN_MCP_PORT)
      : undefined;

if (port !== undefined) {
  const host = process.env.MEMOTURN_MCP_HOST ?? "127.0.0.1";
  await serveHttp(port, host);
  console.error(`memoturn-mcp: streamable HTTP on http://${host}:${port}/mcp`);
} else {
  await buildServer(envCreds()).connect(new StdioServerTransport());
}
