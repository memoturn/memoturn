import { expect, type Page } from "@playwright/test";

// Matches the dev credentials created by scripts/seed.ts.
export const DEV_EMAIL = "admin@memoturn.dev";
export const DEV_PASSWORD = "memoturn-dev-123";

/**
 * Sign in through the UI and wait until the dashboard loads. The sign-in panel leads with
 * social/passwordless and keeps email+password behind a "…password instead" toggle, so we
 * reveal it first. The toggle appears once GET /auth-config resolves.
 */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await revealPasswordForm(page);
  await page.getByLabel("Email").fill(DEV_EMAIL);
  await page.getByLabel("Password").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Reveal the email+password form on the sign-in/sign-up panel. It sits behind a toggle
 * whenever another method (passkey/social/passwordless) is offered — which is always here,
 * since passkey is always enabled. No-op (caught) if the form is already shown.
 */
export async function revealPasswordForm(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /password instead/i })
    .click({ timeout: 10_000 })
    .catch(() => {});
}
