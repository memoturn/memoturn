// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkGfm from "remark-gfm";
import starlightLlmsTxt from "starlight-llms-txt";

const SITE = process.env.MEMOTURN_DOCS_URL ?? "https://docs.memoturn.ai";

// https://astro.build/config
export default defineConfig({
  site: SITE,
  // Astro 6's MDX pipeline doesn't apply GFM to .mdx pages the way .md gets it —
  // without this, markdown tables in .mdx render as literal pipes.
  markdown: { remarkPlugins: [remarkGfm] },
  integrations: [
    starlight({
      title: "Memoturn",
      description:
        "Open-source LLM observability, evals, metrics, prompt management, playground, and datasets — self-hostable and OpenTelemetry-native.",
      logo: { src: "./src/assets/memoturn-mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/memoturn.css"],
      // /llms.txt + /llms-full.txt for AI agents and answer engines.
      plugins: [starlightLlmsTxt()],
      lastUpdated: true,
      editLink: { baseUrl: "https://github.com/memoturn/memoturn/edit/main/apps/docs/" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/memoturn/memoturn" },
        { icon: "external", label: "memoturn.ai", href: "https://memoturn.ai" },
      ],
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#0f1213" } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE}/og-image.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}/og-image.png` } },
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          content: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "memoturn docs",
            url: "https://docs.memoturn.ai",
          }),
        },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
      },
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        { label: "Use cases", slug: "use-cases" },
        {
          label: "Concepts",
          items: [
            { label: "Data model", slug: "concepts" },
            { label: "Architecture", slug: "architecture" },
          ],
        },
        {
          label: "SDKs",
          items: [
            { label: "TypeScript", slug: "sdk-typescript" },
            { label: "Python", slug: "sdk-python" },
            { label: "Go", slug: "sdk-go" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Evaluation", slug: "evaluation" },
            { label: "Prompt management", slug: "prompts" },
            { label: "Integrations", slug: "integrations" },
            { label: "MCP server", slug: "mcp" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "REST API", slug: "api" },
            { label: "Configuration", slug: "configuration" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
        { label: "Deployment", slug: "deployment" },
        { label: "Security hardening", slug: "hardening" },
        { label: "Roadmap", slug: "roadmap" },
      ],
    }),
  ],
});
