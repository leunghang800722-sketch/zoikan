import type { Page } from "@playwright/test";
import { TEST_TEL, TEST_PASSWORD } from "./db-helpers";

export async function loginAs(page: Page, who: keyof typeof TEST_TEL): Promise<void> {
  await page.goto("/login");
  await page.locator("#tel").fill(TEST_TEL[who]);
  await page.locator("#password").fill(TEST_PASSWORD[who]);
  await page.getByRole("button", { name: "登入" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
}

export async function logout(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "登出" });
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 15_000 });
  }
}
