import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * memoturn console — Vite + TanStack Router SPA.
 *
 * In dev, `/api/*` is proxied to the Hono API (default :3001) and the dev API key is
 * injected server-side at the proxy so credentials never reach the browser bundle.
 * In production the console is static assets; real auth (Better Auth session → API)
 * arrives in the platform phase. Deep links work via Vite's SPA history fallback.
 */
const API_TARGET = process.env.MEMOTURN_API_URL ?? "http://localhost:3001";
const PUBLIC_KEY = process.env.MEMOTURN_PUBLIC_KEY ?? "pk-mt-dev";
const SECRET_KEY = process.env.MEMOTURN_SECRET_KEY ?? "sk-mt-dev";
const devAuth = "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
  ],
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("authorization", devAuth);
          });
        },
      },
    },
  },
});
