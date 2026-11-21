import { test, expect } from "@playwright/test";
import { login, unlabeledControls } from "./helpers";

const SECTIONS = [
  ["Today", "Today"], ["World Map", "World Map"], ["Companies", "Companies"], ["Contacts & Discovery", "Contacts & Email Discovery"],
  ["Pipeline", "Pipeline"], ["Drafts & Review", "Drafts & Review"], ["Schedule & Queue", "Schedule & Queue"], ["Inbox", "Inbox"],
  ["CVs & Templates", "CVs & Templates"], ["Imports & Exports", "Imports & Exports"], ["Analytics", "Analytics"], ["Settings & Integrations", "Settings & Integrations"],
];

test("every section opens from the sidebar with one heading, labelled controls and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // Map tiles come from an external provider; their network noise is not an app error.
    if (m.type() === "error" && !/tiles|openfreemap|Failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  await login(page);
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  for (const [link, heading] of SECTIONS) {
    await nav.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    await expect(nav.getByRole("link", { name: link, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await unlabeledControls(page), `unlabelled controls on ${link}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("Today shows a next action with a reason, and the skip link reaches the content", async ({ page }) => {
  await login(page);
  await expect(page.getByText("Next action")).toBeVisible();
  await expect(page.getByText(/^Why:/)).toBeVisible();
  await page.goto("/"); // fresh load: focus starts at the top of the document
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});
