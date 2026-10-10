// WP-AI-DIAG（§37.4／2.5）Playwright e2e——側欄「建議動作卡」。用 fake LLM（`AI_LLM=fake`，userMessage 含「診斷」就回
// 帶 open_page＋one_click_run 兩張卡嘅固定回覆，月份固定假月份 2099-01，永遠唔會鎖）。
// 證明：卡渲染、open_page 連結正確、寫入卡撳咗 5 秒內撤銷唔會發請求（桌面＋手機闊度）。
// 唔會真係執行任何寫入（所有場景都喺 5 秒內撤銷）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { clearAiConversationForTel, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

// 每個場景之前清走對話：否則上一個場景留低嘅卡會令「卡出現」嘅等待提早通過，然後 `.last()` 又跳去新嗰張
test.beforeEach(async () => {
  await clearAiConversationForTel(TEST_TEL.老闆);
});

async function askDiagnosis(page: Page) {
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.getByTestId("ai-assistant-tab").click();
  const input = page.getByTestId("ai-input");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill("請診斷 2099 年 1 月一鍵結算");
  await input.press("Enter");
  await expect(page.getByTestId("ai-action-cards").last()).toBeVisible({ timeout: 30_000 });
}

test("(a) 診斷回覆下面出現兩張卡；open_page 連結正確；回覆文字冇 actions block", async ({ page }) => {
  await askDiagnosis(page);
  const cards = page.getByTestId("ai-action-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("ai-message-assistant").last()).not.toContainText("```");
  await expect(page.getByTestId("ai-message-assistant").last()).not.toContainText("actions");
  const link = page.getByTestId("ai-action-open-page").last();
  await expect(link).toHaveAttribute("href", "/month-close?month=2099-01");
  const write = page.locator('[data-action-type="one_click_run"]').last();
  await expect(write.getByTestId("ai-action-what")).toContainText("2099-01");
  await expect(write.getByTestId("ai-action-basis")).toContainText("依據");
});

test("(b) 寫入卡撳「執行」→ 出現撤銷條；5 秒內撤銷 → 完全冇發 one-click 請求，過咗 6 秒都冇", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/month-close/one-click")) writes.push(`${r.method()} ${r.url()}`);
  });
  await askDiagnosis(page);
  const write = page.locator('[data-action-type="one_click_run"]').last();
  await write.getByTestId("ai-action-run").click();
  await expect(write.getByTestId("ai-action-undo-bar")).toBeVisible();
  await write.getByTestId("undo-bar-undo").click();
  await expect(write.getByTestId("ai-action-undo-bar")).toHaveCount(0);
  await expect(write.getByTestId("ai-action-run")).toBeVisible();
  await page.waitForTimeout(6_500);
  expect(writes).toEqual([]);
  await expect(write.getByTestId("ai-action-done")).toHaveCount(0);
});

test("(c) 手機闊度（側欄 portal）：卡同撤銷條都用得", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/month-close/one-click")) writes.push(r.url());
  });
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.getByTestId("ai-assistant-fab").click(); // 手機：FAB（桌面直向 tab 手機唔出）
  const input = page.getByTestId("ai-input");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill("診斷");
  await input.press("Enter");
  await expect(page.getByTestId("ai-action-cards").last()).toBeVisible({ timeout: 30_000 });
  const write = page.locator('[data-action-type="one_click_run"]').last();
  await write.getByTestId("ai-action-run").click();
  await expect(write.getByTestId("ai-action-undo-bar")).toBeVisible();
  await write.getByTestId("undo-bar-undo").click();
  await page.waitForTimeout(6_000);
  expect(writes).toEqual([]);
});

test("(d) 唔撤銷 → 5 秒後先發請求，body 同月結頁人手操作一字不差（{ month }）；成功標「已做」並加本地備註", async ({ page }) => {
  const bodies: Array<{ method: string; url: string; body: string | null }> = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/month-close/one-click")) bodies.push({ method: r.method(), url: new URL(r.url()).pathname, body: r.postData() });
  });
  await askDiagnosis(page);
  const write = page.locator('[data-action-type="one_click_run"]').last();
  const t0 = Date.now();
  await write.getByTestId("ai-action-run").click();
  await expect(write.getByTestId("ai-action-undo-bar")).toBeVisible();
  expect(bodies).toEqual([]); // 倒數期間冇請求
  await expect(write.getByTestId("ai-action-done")).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
  expect(bodies).toEqual([{ method: "POST", url: "/api/month-close/one-click", body: JSON.stringify({ month: "2099-01" }) }]);
  await expect(page.getByTestId("ai-action-note").last()).toContainText("已做：");
});
