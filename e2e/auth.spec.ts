import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test.describe("owner access", () => {
  test("signed-out visitors are sent to sign-in and private APIs refuse them", async ({ page, request }) => {
    await page.goto("/companies");
    await expect(page).toHaveURL(/\/login$/);
    for (const path of ["/api/backup", "/api/exports/companies", "/api/files/00000000-0000-4000-8000-000000000000"]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(401);
    }
    const forged = await request.get("/api/backup", { headers: { Cookie: "iom_session=forged" } });
    expect(forged.status()).toBe(401);
  });

  test("a wrong passphrase is rejected; the right one signs in and sign-out works", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("e2e-owner@example.test");
    await page.getByLabel("Passphrase").fill("definitely-wrong-passphrase");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email or passphrase is incorrect.")).toBeVisible();
    await login(page);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("first-run setup is closed once an owner exists", async ({ page }) => {
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login$/);
  });
});
