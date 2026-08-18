// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkGfm from "remark-gfm";
import starlightLlmsTxt from "starlight-llms-txt";

const SITE = process.env.MEMOTURN_DOCS_URL ?? "https://docs.memoturn.com";

// GA4 measurement id (G-XXXXXXX). Build-time and optional: unset (local, self-host
// forks) ships zero analytics code. Set via the GA_MEASUREMENT_ID repository variable
// in the deploy-site workflow. The enforcing CSP in public/_headers allowlists the
// gtag/GA origins — keep the two in sync.
const GA_ID = /^G-[A-Z0-9]+$/.test(process.env.PUBLIC_GA_MEASUREMENT_ID ?? "")
  ? process.env.PUBLIC_GA_MEASUREMENT_ID
  : undefined;

// Consent Mode v2: analytics storage defaults to denied in the EEA/UK/CH until the
// visitor accepts the banner (public/consent-banner.js), granted elsewhere; ad signals
// are always denied — we run no ads. A previously stored banner choice ("mt-consent" in
// localStorage) is replayed before config. Keep the region list in sync with
// apps/web/src/lib/analytics.ts and apps/console/src/lib/analytics.ts.
const CONSENT_REGIONS =
  '["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","IS","LI","NO","GB","CH"]';

/** @type {import('@astrojs/starlight/types').StarlightUserConfig["head"]} */
const gtagHead = GA_ID
  ? [
      { tag: "link", attrs: { rel: "preconnect", href: "https://www.googletagmanager.com" } },
      { tag: "script", attrs: { src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`, async: true } },
      {
        tag: "script",
        content:
          `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
          `gtag('js',new Date());` +
          `gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',region:${CONSENT_REGIONS}});` +
          `gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'granted'});` +
          `try{var c=localStorage.getItem('mt-consent');if(c==='granted'||c==='denied'){gtag('consent','update',{analytics_storage:c});}}catch(e){}` +
          `gtag('config','${GA_ID}');`,
      },
      // Same-origin banner script (CSP script-src 'self'); only shipped when analytics is.
      { tag: "script", attrs: { src: "/consent-banner.js", defer: true } },
    ]
  : [];

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
        { icon: "external", label: "memoturn.com", href: "https://memoturn.com" },
      ],
      head: [
        ...gtagHead,
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
            name: "Memoturn docs",
            url: "https://docs.memoturn.com",
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
