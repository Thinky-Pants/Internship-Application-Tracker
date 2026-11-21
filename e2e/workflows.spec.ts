import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { login } from "./helpers";
import { writeWorkbook } from "../src/domain/import/xlsx-write";

test("workbook import: upload, preview counts, commit, report, and a safe reimport", async ({ page }, info) => {
  const file = path.join(info.outputDir, "e2e-companies.xlsx");
  fs.mkdirSync(info.outputDir, { recursive: true });
  fs.writeFileSync(file, writeWorkbook([
    { name: "Notes", rows: [["Just a note"]] },
    { name: "Companies", rows: [["company id", "COMPANY NAME", "website url", "hq country", "HQ City"], ["E2E-1", "Orbit Valve Co", "https://orbit-valve.example", "Sweden", "Gothenburg"], ["E2E-2", "Quartz Motion", "quartz-motion.example", "u.k.", "Bristol"]] },
  ]));
  await login(page);
  for (const round of [1, 2]) {
    await page.goto("/imports");
    // Attach from memory (headless Edge/Chrome here fail to stream on-disk files: ERR_ALPN_NEGOTIATION_FAILED).
    await page.getByLabel("File (.xlsx or .csv, up to 25 MB)").setInputFiles({ name: "e2e-companies.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: fs.readFileSync(file) });
    await page.getByRole("button", { name: "Upload & preview" }).click();
    await expect(page.getByText("Step 4–5 · Normalisation & preview (nothing written yet)")).toBeVisible();
    await expect(page.getByText("No company-name column found")).toBeVisible(); // Notes sheet ignored
    const newCount = page.getByText("New companies", { exact: true }).locator("..");
    await expect(newCount).toContainText(round === 1 ? "2" : "0");
    await page.getByRole("button", { name: "Commit import" }).click();
    await expect(page.getByText(round === 1 ? /Committed: 2 added/ : /Committed: 0 added, 0 updated, 2 unchanged/)).toBeVisible();
  }
  await page.goto("/companies?q=Quartz");
  await expect(page.getByRole("row", { name: /Quartz Motion/ })).toContainText("United Kingdom");
});

test("batch scheduling: approve a reviewed draft and preview recipient-local Monday 07:00", async ({ page }) => {
  await login(page);
  await page.goto("/drafts");
  const row = page.getByRole("row", { name: /ola@fjordline-robotics\.example/ });
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Approve selected" }).click();
  await expect(page.getByText(/Approved 1 messages/)).toBeVisible();
  await page.getByRole("row", { name: /ola@fjordline-robotics\.example/ }).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Schedule selected…" }).click();
  await expect(page).toHaveURL(/\/schedule\/batch/);
  const preview = page.getByRole("row", { name: /Fjordline Robotics/ });
  await expect(preview.getByLabel("Recipient timezone")).toHaveValue("Europe/Oslo");
  await expect(preview).toContainText("07:00");
  await page.getByRole("button", { name: /Schedule 1 messages exactly as previewed/ }).click();
  await expect(page.getByText("Scheduled 1; skipped 0.")).toBeVisible();
});

test("inbox: a reply's suggested category can be corrected manually", async ({ page }) => {
  await login(page);
  await page.goto("/inbox?filter=human");
  await page.getByRole("link", { name: /Kestrel Aero Works/ }).first().click();
  await expect(page.getByText("Rejection (rule)")).toBeVisible();
  await page.getByLabel("Category").selectOption("referral");
  await page.getByRole("button", { name: "Set category" }).click();
  await expect(page.getByText(/Category set manually/)).toBeVisible();
  await expect(page.getByText("Referral (manual)")).toBeVisible();
});

test("global pause shows a banner and can be lifted", async ({ page }) => {
  await login(page);
  await page.goto("/schedule");
  await page.getByLabel("Pause reason").fill("e2e pause");
  await page.getByRole("button", { name: "Pause all sending" }).click();
  await expect(page.getByText("Sending is paused globally")).toBeVisible();
  await page.getByRole("button", { name: "Lift global pause" }).click();
  await expect(page.getByText("Sending is paused globally")).toHaveCount(0);
});
