import { validateRuntimeEnv } from "@memoturn/server";
import { app } from "./app.js";

/**
 * Bun entrypoint. `bun run src/server.bun.ts` serves the Hono app via Bun.serve.
 * This is the default runtime for the memoturn API. SIGTERM/SIGINT drain in-flight
 * requests (up to 10s) before exit so redeploys don't cut off ingest acks.
 */
// Minimal Bun.serve surface — the repo compiles with node types only (this is the
// single file that touches the Bun global; not worth a bun-types dependency).
declare const Bun: {
  serve(options: { port: number; fetch: (req: Request) => Response | Promise<Response> }): {
    stop(closeActiveConnections?: boolean): Promise<void>;
  };
};

validateRuntimeEnv("api");
const port = Number(process.env.API_PORT ?? 3001);

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`[api] memoturn API (Bun) listening on http://localhost:${port}`);
console.log(`[api] OpenAPI: http://localhost:${port}/openapi.json · Swagger UI: /docs`);

function shutdown(signal: string): void {
  console.log(`[api] ${signal} received, draining in-flight requests`);
  setTimeout(() => process.exit(1), 10_000).unref();
  server.stop().then(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
