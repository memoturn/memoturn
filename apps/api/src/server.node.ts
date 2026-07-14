import { serve } from "@hono/node-server";
import { validateRuntimeEnv } from "@memoturn/server";
import { app } from "./app.js";

/**
 * Node entrypoint (portability fallback). The Bun entrypoint (server.bun.ts) is the
 * default; this lets the same app run under Node where Bun isn't available.
 * SIGTERM/SIGINT drain in-flight requests (up to 10s) before exit.
 */
validateRuntimeEnv("api");
const port = Number(process.env.API_PORT ?? 3001);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[api] memoturn API (Node) listening on http://localhost:${port}`);
  console.log(`[api] OpenAPI: http://localhost:${port}/openapi.json · Swagger UI: /docs`);
});

function shutdown(signal: string): void {
  console.log(`[api] ${signal} received, draining in-flight requests`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
