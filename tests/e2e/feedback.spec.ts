// P2.5「現場反映」開會模式 Playwright e2e（`AI_LLM=fake`，見
// playwright.config.ts webServer.env，同 `ai.spec.ts` 一致做法）。
//
// 流程：主管開會 → 兩輪 → 整理 → 預覽 → 改一欄 → 送出 → 老闆登入見
// badge 1 → 開清單 → 睇詳情 → 改狀態 → badge 0；雞頭冇入口＋`/feedback`
// 403。
//
// PDPO：斷言唔寫死真名/電話，用測試帳號角色名/佢哋自己輸入嘅假意見
// 文字比對（同 wp3.spec.ts／ai.spec.ts 一致做法）。
import { test, expect } from "@playwright/test";
import { loginAs, logout } from "./helpers";
import { clearAllFeedback } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const EDITED_TITLE = "更表編輯器手機版撳格太細（已編輯）";

test.beforeAll(async () => {
  await clearAllFeedback();
});

test("主管開會反映 → 兩輪對話 → 整理 → 改標題 → 送出", async ({ page }) => {
  await loginAs(page, "主管");
  await page.goto("/roster");

  await page.getByTestId("ai-assistant-tab").click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("ai-feedback-start").click();
  await expect(page.getByTestId("ai-feedback-mode")).toBeVisible({ timeout: 20_000 });

  // 第一輪
  const input = page.getByTestId("ai-input");
  await input.fill("更表編輯器手機版撳格太細，成日撳錯人");
  await input.press("Enter");
  await expect(page.getByTestId("ai-message-assistant").first()).toBeVisible({ timeout: 20_000 });

  // 「整理並送出」未夠 2 輪，仲係 disabled
  await expect(page.getByTestId("ai-feedback-summarize")).toBeDisabled();

  // 第二輪
  await input.fill("全部盤嘅更表都係咁，想格仔大啲");
  await input.press("Enter");
  await expect(page.getByTestId("ai-message-assistant").nth(1)).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId("ai-feedback-summarize")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("ai-feedback-summarize").click();

  await expect(page.getByTestId("ai-feedback-preview")).toBeVisible({ timeout: 20_000 });

  // 改標題呢一欄
  const titleField = page.getByTestId("ai-feedback-field-title");
  await titleField.fill(EDITED_TITLE);

  await page.getByTestId("ai-feedback-submit").click();

  // 送出之後返回普通模式（開會模式 UI 消失）
  await expect(page.getByTestId("ai-feedback-mode")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("ai-feedback-preview")).toHaveCount(0);
});

test("老闆登入見「現場意見」badge 1 → 開清單 → 睇詳情 → 改狀態 → badge 0", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/");

  const navLink = page.getByRole("link", { name: /現場意見/ });
  await expect(navLink).toBeVisible();
  await expect(navLink).toContainText("1");

  await navLink.click();
  await expect(page).toHaveURL(/\/feedback$/);

  const row = page.getByTestId("feedback-row").filter({ hasText: EDITED_TITLE }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(page).toHaveURL(/\/feedback\/[^/]+$/);
  await expect(page.getByTestId("feedback-summary")).toContainText(EDITED_TITLE);
  await expect(page.getByTestId("feedback-summary")).toContainText("未評估技術可行性");

  await page.getByTestId("feedback-status-forwarded").click();
  await expect(page.getByTestId("feedback-status-pill")).toContainText("已轉交", { timeout: 10_000 });

  await page.goto("/");
  const navLinkAfter = page.getByRole("link", { name: /現場意見/ });
  await expect(navLinkAfter).toBeVisible();
  await expect(navLinkAfter).not.toContainText("1");
});

test("雞頭：冇「現場意見」入口，直接打 /feedback → 403 畫面", async ({ page }) => {
  await logout(page);
  await loginAs(page, "雞頭A");
  await page.goto("/");
  await expect(page.getByRole("link", { name: /現場意見/ })).toHaveCount(0);
  await expect(page.getByTestId("ai-assistant-tab")).toHaveCount(0);

  await page.goto("/feedback");
  await expect(page.getByTestId("feedback-forbidden")).toBeVisible();
});

test("主管：有「開會反映」但冇「現場意見」清單入口，直接打 /feedback → 403 畫面", async ({ page }) => {
  await logout(page);
  await loginAs(page, "主管");
  await page.goto("/");
  await expect(page.getByRole("link", { name: /現場意見/ })).toHaveCount(0);

  await page.goto("/feedback");
  await expect(page.getByTestId("feedback-forbidden")).toBeVisible();
});
