// WP-AI2 Playwright e2e——側欄 AI 助手 UI（唔打真 AI Hub，用 fake LLM，
// 見 `playwright.config.ts` webServer.env 嘅 `AI_LLM=fake` → `getLlmClient()`
// 喺 `src/lib/ai/llm.ts` 回一個唔會真係連 Anthropic 嘅假 client）。
//
// PDPO：斷言全部用 DB 查出嚟嘅值（site id）或者測試帳號角色名比對，唔寫
// 死真名/電話（同 wp3.spec.ts 一致做法）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { findSiteIdByName, clearAiConversationForTel, TEST_TEL, prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" }); // 同一個「老闆」用戶共用同一條 ai_conversations 記錄，順序執行避免互相干擾

test.beforeAll(async () => {
  // 每次跑呢個 spec file 之前，清走「老闆」呢個測試帳號舊嘅 AI 對話記錄
  // ——等「開側欄見歡迎語」呢類斷言唔會因為上一次跑剩低嘅記錄而唔穩定。
  await clearAiConversationForTel(TEST_TEL.老闆);
});

test("(a) 老闆登入見到「在勤助手」tab，撳開見歡迎語同 4 個例子", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/roster");

  const tab = page.getByTestId("ai-assistant-tab");
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();

  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ai-welcome")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ai-example-button")).toHaveCount(4);
});

test("(b) 撳例子 → 出現用戶訊息＋助手回覆（fake LLM 腳本）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.getByTestId("ai-assistant-tab").click();
  await expect(page.getByTestId("ai-welcome")).toBeVisible({ timeout: 20_000 });

  const firstExample = page.getByTestId("ai-example-button").first();
  const exampleText = await firstExample.textContent();
  await firstExample.click();

  await expect(page.getByTestId("ai-message-user").last()).toHaveText(exampleText ?? "", { timeout: 20_000 });
  const assistantReply = page.getByTestId("ai-message-assistant").last();
  await expect(assistantReply).toBeVisible({ timeout: 20_000 });
  await expect(assistantReply).not.toHaveText("");
  await expect(page.getByTestId("ai-welcome")).toHaveCount(0);
});

test("(c) 雞頭登入冇「在勤助手」tab（DOM 零元素），直接打 /api/ai/chat → 403", async ({ page }) => {
  await loginAs(page, "雞頭A");
  await page.goto("/roster");
  await expect(page.getByTestId("ai-assistant-tab")).toHaveCount(0);
  await expect(page.getByTestId("ai-assistant-panel")).toHaveCount(0);

  const res = await page.request.post("/api/ai/chat", { data: { message: "呢個盤幾多人？" } });
  expect(res.status()).toBe(403);
});

test("(d) 清空對話後歡迎語返回", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.getByTestId("ai-assistant-tab").click();

  // 未必係空對話（可能俾上一個場景 (b) 留低咗記錄）——確保呢度真係有
  // 嘢可以清（冇就送一句），先至有得斷言「清空之後歡迎語返嚟」。
  if (!(await page.getByTestId("ai-welcome").isVisible().catch(() => false))) {
    // 已經有記錄，跳過送新訊息
  } else {
    const input = page.getByTestId("ai-input");
    await input.fill("你好");
    await input.press("Enter");
    await expect(page.getByTestId("ai-message-assistant").first()).toBeVisible({ timeout: 20_000 });
  }
  await expect(page.getByTestId("ai-welcome")).toHaveCount(0);

  await page.getByTestId("ai-clear-conversation").click();
  await page.getByTestId("ai-clear-confirm").click();

  await expect(page.getByTestId("ai-welcome")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ai-message-user")).toHaveCount(0);
  await expect(page.getByTestId("ai-message-assistant")).toHaveCount(0);
});

test("(e) 更表頁開側欄問「呢個盤」→ 請求 body 含 site_id/month", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "老闆");
  await page.goto(`/roster/${siteId}/2026-07`);

  let capturedBody: { context?: { site_id?: string; month?: string; path?: string } } | null = null;
  await page.route("**/api/ai/chat", async (route) => {
    capturedBody = route.request().postDataJSON();
    await route.continue();
  });

  await page.getByTestId("ai-assistant-tab").click();
  const input = page.getByTestId("ai-input");
  await input.fill("呢個盤今個月排咗幾多人？");
  await input.press("Enter");

  await expect(page.getByTestId("ai-message-assistant").last()).toBeVisible({ timeout: 20_000 });

  expect(capturedBody).not.toBeNull();
  expect(capturedBody!.context?.site_id).toBe(siteId);
  expect(capturedBody!.context?.month).toBe("2026-07");
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
