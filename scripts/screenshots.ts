/**
 * Capture console screenshots for the docs + marketing site. Prereqs: `bun run dev`
 * running (api + worker + console) and seeded data (`bun run seed`, `bun run seed:demo`).
 *
 *   bun run screenshots        # writes docs/images/*.png (1440-wide @2x, dark theme)
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.CONSOLE_URL ?? "http://localhost:3000";
const EMAIL = process.env.MEMOTURN_EMAIL ?? "admin@memoturn.dev";
const PASSWORD = process.env.MEMOTURN_PASSWORD ?? "memoturn-dev-123";
const OUT = "docs/images";

const PAGES: { name: string; path: string; waitFor?: string }[] = [
  { name: "dashboard", path: "/dashboard", waitFor: "text=Dashboard" },
  { name: "traces", path: "/traces", waitFor: "text=Traces" },
  { name: "sessions", path: "/sessions", waitFor: "text=Sessions" },
  { name: "prompts", path: "/prompts", waitFor: "text=Prompts" },
  { name: "prompt-detail", path: "/prompts/support-reply", waitFor: "text=Channels" },
  { name: "datasets", path: "/datasets", waitFor: "text=Datasets" },
  { name: "experiments", path: "/experiments", waitFor: "text=Experiments" },
  { name: "playground", path: "/playground", waitFor: "text=Playground" },
  { name: "evaluators", path: "/evaluators", waitFor: "text=Evaluators" },
  { name: "embeddings", path: "/embeddings", waitFor: "text=Embeddings" },
  { name: "monitors", path: "/monitors", waitFor: "text=Monitors" },
  { name: "review", path: "/review", waitFor: "text=Review queues" },
  { name: "settings", path: "/settings", waitFor: "text=Settings" },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();

// The console persists its theme choice; pin dark before the app boots.
await page.addInitScript(() => {
  try {
    window.localStorage.setItem("theme", "dark");
  } catch {}
});

// Sign in (Better Auth). Password entry sits behind the passkey/magic-link options.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.click("text=Sign in with a password instead");
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15_000 }).catch(() => {});

// Expand the sidebar so captures show the full nav IA, not just the icon rail.
const collapsedToggle = page.locator('[data-sidebar="trigger"], button[aria-label*="idebar"]').first();
if (await collapsedToggle.count()) {
  const expanded = await page.locator('[data-state="expanded"][data-sidebar="sidebar"]').count();
  if (!expanded) await collapsedToggle.click();
  await page.waitForTimeout(400);
}

for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle" });
  if (p.waitFor) await page.waitForSelector(p.waitFor, { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600); // let queries settle
  await page.screenshot({ path: `${OUT}/${p.name}.png`, fullPage: true });
  console.log(`  ${p.name}`);
}

// Trace detail (waterfall). Rows navigate via onClick (no hrefs), so go straight to a
// known seed:demo trace — ids are deterministic (--seed 42), stable across reseeds.
await page.goto(`${BASE}/traces/demo-trace-d0-857`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Observations", { timeout: 8_000 }).catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/trace-detail.png`, fullPage: true });
console.log("  trace-detail");

await context.close();
await browser.close();
console.log(`screenshots written to ${OUT}/`);
