import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `CF_ENV=staging bun run build` encodes the staging worker name + custom domain
// into the dist wrangler.json (the cloudflare vite plugin flattens the source
// wrangler.jsonc at build time and drops env.* overrides, so this is the
// supported way to target staging). Marketing has no API service binding.
const STAGING = process.env.CF_ENV === "staging";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3003, strictPort: true },
  preview: { port: 3003, strictPort: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: (cfg) => {
        if (STAGING) {
          cfg.name = "memoturn-web-staging";
          cfg.routes = [{ pattern: "staging.memoturn.ai", custom_domain: true }];
        }
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
