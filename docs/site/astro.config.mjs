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
			description: "Memory for AI agents — typed memories, hybrid recall, and branchable per-profile databases.",
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
						{ label: "Namespaces & profiles", slug: "profiles" },
						{ label: "Typed memories", slug: "memories" },
						{ label: "Hybrid recall", slug: "recall" },
						{ label: "Branching & burner branches", slug: "branching" },
						{ label: "Consistency & txid", slug: "consistency" },
						{ label: "Documents, KV, SQL & vectors", slug: "data-model" },
						{ label: "Sessions & transcripts", slug: "sessions" },
					],
				},
				{
					label: "Integrations",
					items: [
						{ label: "MCP server", slug: "mcp" },
						{ label: "Server-side extraction", slug: "extraction" },
						{ label: "Auto-embedding", slug: "embeddings" },
					],
				},
				{
					label: "Operate",
					items: [
						{ label: "Deployment", slug: "deployment" },
						{ label: "Configuration", slug: "configuration" },
						{ label: "Security & tokens", slug: "security" },
						{ label: "Scaling & tiering", slug: "scaling" },
						{ label: "Observability", slug: "observability" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "REST API", slug: "api-rest" },
						{ label: "CLI", slug: "cli" },
						{ label: "TypeScript SDK", slug: "sdk-typescript" },
						{ label: "Python SDK", slug: "sdk-python" },
					],
				},
				{ label: "Roadmap", slug: "roadmap" },
			],
		}),
	],
});
