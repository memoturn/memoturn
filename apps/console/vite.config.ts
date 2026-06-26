import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * memoturn console — Vite + TanStack Router SPA.
 *
 * In dev, `/api/*` is proxied to the Hono API (default :3001), forwarding cookies both
 * ways so the Better Auth session works as same-origin. `/api/v1/*` -> API `/v1/*` and
 * `/api/auth/*` -> API `/auth/*`. Deep links work via Vite's SPA history fallback.
 */
const API_TARGET = process.env.MEMOTURN_API_URL ?? "http://localhost:3001";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), viteReact(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
