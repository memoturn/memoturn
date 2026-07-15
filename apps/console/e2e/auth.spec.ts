import { expect, test } from "@playwright/test";
import { login, revealPasswordForm } from "./helpers";

test("redirects unauthenticated visitors to the login page", async ({ page }) => {
  await page.goto("/traces");
  await expect(page).toHaveURL(/\/login/);
  // The sign-in panel has loaded (its email field is present once /auth-config resolves).
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("signs in with the dev credentials and reaches the dashboard", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // The authed shell (topbar brand) is present.
  await expect(page.getByRole("link", { name: "memoturn" })).toBeVisible();
});

test("rejects a wrong password and stays on the login page", async ({ page }) => {
  await page.goto("/login");
  await revealPasswordForm(page);
  await page.getByLabel("Email").fill("admin@memoturn.dev");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The sign-in error surfaces as a toast (sonner), and we stay on /login.
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
