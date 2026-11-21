import { expect, type Page } from "@playwright/test";
import { E2E_OWNER } from "./credentials";

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Passphrase").fill(E2E_OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Visible form controls that have no accessible label. */
export async function unlabeledControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea")]
      .filter((el) => {
        const e = el as HTMLInputElement;
        if (e.type === "hidden" || e.offsetParent === null) return false;
        return !(e.labels?.length || e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.closest("label"));
      })
      .map((el) => `${el.tagName.toLowerCase()}[name=${(el as HTMLInputElement).name}]`),
  );
}

export async function flash(page: Page) {
  return page.getByRole("status").or(page.getByRole("alert")).first();
}
