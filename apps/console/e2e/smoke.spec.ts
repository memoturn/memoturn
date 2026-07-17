import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("the sidebar exposes the core navigation", async ({ page }) => {
  // Scoped to the sidebar: the topbar breadcrumb renders the current page with role="link"
  // too, so an unscoped lookup is ambiguous for the active route's name.
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  for (const name of ["Dashboard", "Traces", "Prompts", "Datasets", "Playground"]) {
    await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
  }
});

test("navigates to the traces page", async ({ page }) => {
  await page.getByRole("link", { name: "Traces", exact: true }).click();
  await expect(page).toHaveURL(/\/traces/);
  await expect(page.getByRole("heading", { name: "Traces" })).toBeVisible();
});

test("lists the seeded support-reply prompt", async ({ page }) => {
  await page.getByRole("link", { name: "Prompts", exact: true }).click();
  await expect(page).toHaveURL(/\/prompts/);
  await expect(page.getByRole("heading", { name: "Prompts" })).toBeVisible();
  // Seeded by scripts/seed.ts under the "support" folder.
  await expect(page.getByRole("link", { name: /support-reply/ })).toBeVisible();
});

test("the project switcher shows the default project", async ({ page }) => {
  // The switcher is a DropdownMenu trigger button labelled "Switch project"; the active
  // project's name renders inside the trigger.
  const switcher = page.getByRole("button", { name: "Switch project" });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText(/Default Project/);
});
