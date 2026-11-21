import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test("filter primary companies missing an email in the table, carry it to the map, and save the view", async ({ page }) => {
  await login(page);
  await page.goto("/companies");
  await page.getByLabel("Priority").selectOption("primary");
  await page.getByLabel("Email").selectOption("missing");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/priority=primary/);
  await expect(page.getByText("Showing: primary priority · no email")).toBeVisible();
  // Every listed company shows "missing" in the email column.
  const rows = page.locator("table.data tbody tr");
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText("missing");

  await page.getByLabel("Saved view name").fill("Primary, no email");
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByRole("link", { name: "Primary, no email" })).toBeVisible();

  await page.getByRole("link", { name: "Show on map" }).click();
  await expect(page).toHaveURL(/\/map\?.*priority=primary.*email=missing/);
  await expect(page.getByText(`of ${n} matching companies have map coordinates`)).toBeVisible();
});

test("the map renders pins with a legend and switches to the discovery colour mode", async ({ page }) => {
  await login(page);
  await page.goto("/map");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  const legend = page.getByLabel("Legend");
  await expect(legend).toContainText("Outreach progress:");
  await expect(legend).toContainText("Awaiting reply");
  await page.getByRole("button", { name: "Contact discovery" }).click();
  await expect(legend).toContainText("Contact discovery:");
  await expect(legend).toContainText("No suitable match");
  // Linked list: searching narrows it.
  await page.getByLabel("Search the map").fill("Kestrel");
  await expect(page.getByText("1 mapped companies")).toBeVisible();
});

test("a company page shows contacts, address quality and the discovery workspace", async ({ page }) => {
  await login(page);
  await page.goto("/companies?q=Fjordline");
  await page.getByRole("link", { name: "Fjordline Robotics" }).click();
  await expect(page).toHaveTitle(/Fjordline Robotics/);
  await expect(page.getByText("Provider-verified").first()).toBeVisible();
  await expect(page.getByText("Catch-all").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Search people" })).toBeVisible();
});
