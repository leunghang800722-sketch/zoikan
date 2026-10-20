// AI-PII-2 e2e：老闆問助手「邊個 9 月離職」→ 助手（fake LLM 真 call longterm_leavers 工具）答到離職者姓名（合成假名）；
// 答覆唔含身份證／電話／銀行等被鎖資料。需要 AI_DATABASE_URL（zoikan_ai_ro）連到同一個 DB（本機跑：設 AI_DB_PASSWORD 後 db:reset／ensure-ai-role）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { clearAiConversationForTel, TEST_TEL, prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const RAND = Math.random().toString(36).slice(2, 8);
const NAME = `測試離職-ai-${RAND}`;
let guardId: string;

test.beforeAll(async () => {
  await clearAiConversationForTel(TEST_TEL.老闆);
  const g = await prisma.guard.create({
    data: { nameZh: NAME, employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), leaveDate: new Date("2026-09-12"), hkid: "A1234563", tel: "61234567", bankAccountNo: "999-888777-001", createdBy: "test-e2e" },
  });
  guardId = g.id;
});

test.afterAll(async () => {
  await prisma.guard.deleteMany({ where: { id: guardId } });
  await clearAiConversationForTel(TEST_TEL.老闆);
});

test("老闆問「邊個 9 月離職」→ 助手答到離職者姓名同離職日，唔含身份證／電話／銀行", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/roster");
  await page.getByTestId("ai-assistant-tab").click();
  await expect(page.getByTestId("ai-welcome")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("ai-input").fill("邊個 9 月離職？");
  await page.getByTestId("ai-submit").click();
  const reply = page.getByTestId("ai-message-assistant").last();
  await expect(reply).toContainText(NAME, { timeout: 30_000 });
  await expect(reply).toContainText("2026-09-12");
  const txt = await reply.innerText();
  for (const v of ["A1234563", "61234567", "999-888777-001"]) expect(txt).not.toContain(v);
});
