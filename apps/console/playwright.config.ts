import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the memoturn console. Playwright boots the API and the console dev
 * server (which proxies /api -> the API so Better Auth cookies are same-origin), seeds
 * the dev org/project/user in globalSetup, then drives the SPA in a browser.
 *
 * Locally it reuses an already-running stack (`bun run dev`); in CI it starts fresh.
 * The full stack (Postgres/Doris/Redis/MinIO) must be reachable — this suite is
 * not part of the infra-free `bun run test`; run it with `bun --filter @memoturn/console test:e2e`.
 */
const CI = !!process.env.CI;
// In CI the job env carries DATABASE_URL etc.; `start` inherits it. Locally `dev` loads .env.
const apiCommand = CI ? "bun --filter @memoturn/api start" : "bun --filter @memoturn/api dev";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: apiCommand,
      url: "http://localhost:3001/v1/health",
      reuseExistingServer: !CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      // The suite signs in many times from one IP; disable the auth rate limiter so the
      // built-in sign-in sub-limit doesn't 429 legitimate repeated logins. Test-only.
      env: { ...process.env, AUTH_RATE_LIMIT_DISABLED: "true" },
    },
    {
      command: "bun --filter @memoturn/console dev",
      url: "http://localhost:3000",
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
