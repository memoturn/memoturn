import { expect, type Page } from "@playwright/test";

// Matches the dev credentials created by scripts/seed.ts.
export const DEV_EMAIL = "admin@memoturn.dev";
export const DEV_PASSWORD = "memoturn-dev-123";

/** Sign in through the UI and wait until the dashboard loads. */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DEV_EMAIL);
  await page.getByLabel("Password").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
