import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("an owner sees the API keys tab with the create form (admin-only surface)", async ({ page }) => {
  await page.goto("/settings"); // api-keys is the default section
  await expect(page.getByText("Create API key", { exact: true })).toBeVisible();
  // The scope picker offers the admin scope but it is OFF by default: the form's default
  // scopes are read/write/ingest, so exactly one of the four checkboxes is unchecked.
  const scopes = page.getByRole("checkbox");
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await expect(scopes.filter({ hasNot: page.locator("[data-state=checked]") })).toHaveCount(1);
});

test("the cost budget form exposes the hard-cap switch", async ({ page }) => {
  await page.goto("/settings?tab=alerts");
  await expect(page.getByText("Monthly budget (USD)", { exact: true })).toBeVisible();
  await expect(page.getByText("Hard cap", { exact: true })).toBeVisible();
});

test("the ingest-health ops page loads for an owner", async ({ page }) => {
  await page.goto("/ops");
  await expect(page.getByText(/DLQ/i).first()).toBeVisible();
});
