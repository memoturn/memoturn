/**
 * Capture console screenshots for the docs. Prereqs: `bun run dev` running (api + worker
 * + console) and seeded data (`bun run seed`, `bun run quickstart`).
 *
 *   bun run screenshots        # writes docs/images/*.png
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
  { name: "datasets", path: "/datasets", waitFor: "text=Datasets" },
  { name: "playground", path: "/playground", waitFor: "text=Playground" },
  { name: "evaluators", path: "/evaluators", waitFor: "text=Evaluators" },
  { name: "review", path: "/review", waitFor: "text=Review queues" },
  { name: "settings", path: "/settings", waitFor: "text=Settings" },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } } as never);

// Sign in (Better Auth).
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15_000 }).catch(() => {});

for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle" });
  if (p.waitFor) await page.waitForSelector(p.waitFor, { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600); // let queries settle
  await page.screenshot({ path: `${OUT}/${p.name}.png`, fullPage: true });
  console.log(`  ✓ ${p.name}`);
}

// Trace detail (waterfall) — open the first trace from the list.
await page.goto(`${BASE}/traces`, { waitUntil: "networkidle" });
const firstTrace = page.locator('a[href^="/traces/"]').first();
if (await firstTrace.count()) {
  await firstTrace.click();
  await page.waitForSelector("text=Timeline", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/trace-detail.png`, fullPage: true });
  console.log("  ✓ trace-detail");
}

await browser.close();
console.log(`screenshots written to ${OUT}/`);
