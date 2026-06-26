import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("redirects unauthenticated visitors to the login page", async ({ page }) => {
  await page.goto("/traces");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("signs in with the dev credentials and reaches the dashboard", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // The authed shell (topbar brand) is present.
  await expect(page.getByRole("link", { name: "memoturn" })).toBeVisible();
});

test("rejects a wrong password and stays on the login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@memoturn.dev");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  // The shadcn Form surfaces the sign-in error as a FormMessage under the field.
  await expect(page.locator('[data-slot="form-message"]').first()).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
