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
      description:
        "Open-source LLM observability, evals, metrics, prompt management, playground, and datasets — self-hostable and OpenTelemetry-native.",
      logo: { src: "./src/assets/memoturn-mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/memoturn.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/memoturn/memoturn" }],
      head: [
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE}/og-image.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}/og-image.png` } },
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
          ],
        },
        { label: "Deployment", slug: "deployment" },
        { label: "Roadmap", slug: "roadmap" },
      ],
    }),
  ],
});
