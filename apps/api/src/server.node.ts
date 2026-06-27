import { serve } from "@hono/node-server";
import { validateRuntimeEnv } from "@memoturn/server";
import { app } from "./app.js";

/**
 * Node entrypoint (portability fallback). The Bun entrypoint (server.bun.ts) is the
 * default; this lets the same app run under Node where Bun isn't available.
 */
validateRuntimeEnv("api");
const port = Number(process.env.API_PORT ?? 3001);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[api] memoturn API (Node) listening on http://localhost:${port}`);
  console.log(`[api] OpenAPI: http://localhost:${port}/openapi.json · Swagger UI: /docs`);
});
