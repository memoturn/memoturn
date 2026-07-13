// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const SITE = process.env.MEMOTURN_DOCS_URL ?? "https://docs.memoturn.ai";

// https://astro.build/config
export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: "Memoturn",
      description: "A self-hostable, durable runtime for AI agents.",
      logo: { src: "./src/assets/memoturn-mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/memoturn.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memoturn/memoturn" }],
      head: [
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        // TODO: add a designed 1200×630 og-image.png to public/ and restore
        // og:image + twitter:image + summary_large_image.
        { tag: "meta", attrs: { name: "twitter:card", content: "summary" } },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
      },
      sidebar: [
        { label: "Quickstart", slug: "quickstart" },
        { label: "Use cases", slug: "use-cases" },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "architecture" },
            { label: "Agents & actors", slug: "agents" },
            { label: "Sessions & turns", slug: "sessions" },
            { label: "Guardrails & approvals", slug: "guardrails" },
            { label: "Durable execution", slug: "fibers" },
            { label: "Workspace", slug: "workspace" },
            { label: "Memory", slug: "memory" },
          ],
        },
        {
          label: "Execution",
          items: [
            { label: "The execution ladder", slug: "execution-ladder" },
            { label: "Sandboxing", slug: "sandboxing" },
            { label: "Tools", slug: "tools" },
            { label: "Extensions", slug: "extensions" },
          ],
        },
        {
          label: "Models & protocols",
          items: [
            { label: "Providers", slug: "providers" },
            { label: "MCP", slug: "mcp" },
            { label: "A2A", slug: "a2a" },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Deployment", slug: "deployment" },
            { label: "Operations", slug: "operations" },
            { label: "Security", slug: "security" },
            { label: "Single sign-on (OIDC)", slug: "sso" },
            { label: "SCIM provisioning", slug: "scim" },
            { label: "Runtime API keys", slug: "api-keys" },
            { label: "Usage metering & billing", slug: "billing" },
            { label: "Open-core & Enterprise", slug: "enterprise" },
            { label: "Scaling out", slug: "scaling" },
            { label: "Observability", slug: "observability" },
            { label: "Webhooks", slug: "webhooks" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "configuration" },
            { label: "REST API", slug: "api-rest" },
            { label: "WebSocket API", slug: "api-websocket" },
            { label: "CLI", slug: "cli" },
          ],
        },
        { label: "Roadmap", slug: "roadmap" },
      ],
    }),
  ],
});
