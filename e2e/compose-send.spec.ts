import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

async function newDraftFor(page: Page, company: string) {
  await page.goto(`/companies?q=${encodeURIComponent(company)}`);
  await page.getByRole("link", { name: company }).click();
  await page.getByRole("link", { name: "Prepare draft" }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]+/);
}

test("an unresolved placeholder blocks approval until it is removed", async ({ page }) => {
  await login(page);
  await newDraftFor(page, "Pacific Drive Systems");
  const body = page.getByLabel("Body (HTML: p, br, b, i, a, ul, li)");
  await body.fill(`${await body.inputValue()}<p>{{skill}}</p>`);
  await expect(page.getByText("Unresolved placeholders (block approval): {{skill}}")).toBeVisible();
  await page.getByRole("button", { name: "Save as new revision" }).click();
  await expect(page.getByText("Saved revision 2")).toBeVisible();
  await expect(page.getByText("Cannot approve yet")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve revision/ })).toHaveCount(0);

  const body2 = page.getByLabel("Body (HTML: p, br, b, i, a, ul, li)");
  await body2.fill((await body2.inputValue()).replace("<p>{{skill}}</p>", ""));
  await page.getByRole("button", { name: "Save as new revision" }).click();
  await expect(page.getByRole("button", { name: "Approve revision 3" })).toBeVisible();
});

test("approve and send now: the worker submits through the mock mailbox and records the sent copy", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await newDraftFor(page, "Pacific Drive Systems");
  const subject = `E2E send ${Date.now()}`;
  await page.getByLabel("Subject").fill(subject);
  await page.getByRole("button", { name: "Save as new revision" }).click();
  await expect(page.getByText("Saved revision 2")).toBeVisible();
  await page.getByRole("button", { name: "Approve & send now" }).click();
  await expect(page.getByText(/queued to send within about a minute/)).toBeVisible();

  // Poll the queue until the worker has dispatched and reconciled the message.
  await expect(async () => {
    await page.goto("/schedule?view=queue");
    const row = page.locator("tr", { hasText: subject });
    await expect(row).toContainText(/recorded sent|submitted/);
  }).toPass({ timeout: 150_000, intervals: [3_000] });
  await page.locator("tr", { hasText: subject }).getByRole("link").first().click();
  await expect(page.getByText("Message details")).toBeVisible();
  await expect(page.getByText(/provider accepted|sent copy found/).first()).toBeVisible();
});

test("editing approved, scheduled content supersedes the queued revision", async ({ page }) => {
  await login(page);
  await newDraftFor(page, "Lotus Grid Tech");
  await page.getByRole("button", { name: /^Approve revision 1/ }).click();
  await expect(page.getByText("Approved revision 1")).toBeVisible();
  // Recipient-local schedule; the timezone is suggested from the company office.
  await expect(page.getByLabel("Recipient timezone (used in recipient mode)")).toHaveValue("Asia/Shanghai");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page).toHaveURL(/\/schedule/);
  await page.goBack();
  await page.reload();
  await page.getByLabel("Subject").fill("Edited after approval");
  await page.getByRole("button", { name: "Save as new revision" }).click();
  await expect(page.getByText(/previous approval was revoked\. 1 queued send\(s\) of the old revision were superseded/)).toBeVisible();
  await expect(page.getByText("Cannot approve yet").or(page.getByRole("button", { name: "Approve revision 2" }))).toBeVisible();
});
