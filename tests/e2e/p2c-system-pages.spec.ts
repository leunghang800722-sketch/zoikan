// P2-C Playwright e2e：系統頁＋助手面板重新實作版面（README §16-20／
// §19-24）——覆蓋要求驗收準則列明嘅五樣嘢：用戶頁欄名＋狀態 pill、角色
// 頁矩陣 checkbox 樣式＋硬性禁止格、操作紀錄 pill、改密碼強度條隨輸入
// 變、助手歡迎 chips 三句。順帶喺 1440／375 兩個闊度截圖存底（俾 Opus
// 驗收對照 README，唔係斷言本身）。
//
// 限制（老闆交帶）：唔可以真係改 e2e 帳號（老闆 90000001）嘅密碼——改
// 密碼嗰個 test 淨係測表單校驗／強度條反應，唔撳「更新密碼」提交。
import path from "node:path";
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { clearAiConversationForTel, TEST_TEL, prisma } from "./db-helpers";

const SCREENSHOT_DIR = "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/p2c";

async function shoot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

test.describe("P2-C 系統頁", () => {
  test("(1) 用戶管理：欄名＋狀態 pill", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, "老闆");
    await page.goto("/users");

    const headerRow = page.locator("thead tr");
    for (const col of ["名", "電話", "角色", "掛邊個", "最後登入", "狀態", "操作"]) {
      await expect(headerRow.getByText(col, { exact: true })).toBeVisible();
    }

    const rows = page.getByTestId("user-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    // 狀態 pill 一定係「啟用」／「待啟用」／「停用」三選一。
    const statusText = await page.getByTestId("user-status-pill").first().innerText();
    expect(["啟用", "待啟用", "停用"]).toContain(statusText.trim());

    // A2：自己嗰行（登入緊嘅「老闆」，用電話定位而唔係寫死真名）唔顯示
    // 「重設密碼」掣——同 API 側 id === session.userId → 400 一致。
    const ownRow = rows.filter({ hasText: TEST_TEL.老闆 });
    await expect(ownRow).toHaveCount(1);
    await expect(ownRow.getByTestId("user-reset-password-button")).toHaveCount(0);

    // §16：頁首「角色」FilterChip——揀「老闆」之後行數應該收窄（唔多過
    // 之前），而且自己（登入緊嗰個「老闆」）嗰行仍然喺入面；揀返「全部」
    // 行數要返晒去。
    const beforeCount = await rows.count();
    const roleSelect = page.getByTestId("user-role-filter");
    await roleSelect.selectOption({ label: "老闆" });
    await expect(async () => {
      expect(await rows.count()).toBeLessThanOrEqual(beforeCount);
      expect(await rows.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    await expect(rows.filter({ hasText: TEST_TEL.老闆 })).toHaveCount(1);
    await roleSelect.selectOption({ label: "全部" });
    await expect(rows).toHaveCount(beforeCount);

    await shoot(page, "16-users-1440");
    await page.setViewportSize({ width: 375, height: 812 });
    await shoot(page, "16-users-375");
  });

  test("(2) 角色權限管理：矩陣 checkbox 樣式＋硬性禁止格", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, "老闆");
    await page.goto("/roles");

    // 揀「老闆」（README 矩陣示例——「自己保安員」全禁），保證見到至少
    // 一格硬性禁止。
    const permsResponse = page.waitForResponse((r) => /\/api\/roles\/[^/]+\/permissions/.test(r.url()) && r.status() === 200);
    await page.getByTestId("role-list-item").filter({ hasText: "老闆" }).first().click();
    await permsResponse;

    const checkboxes = page.getByTestId("role-matrix-checkbox");
    await expect(checkboxes.first()).toBeVisible({ timeout: 15_000 });

    // 18px 圓角 5px 樣式：抽第一個 checkbox 核對實際 computed style。
    const box = checkboxes.first();
    const size = await box.evaluate((el) => ({
      w: getComputedStyle(el).width,
      h: getComputedStyle(el).height,
      radius: getComputedStyle(el).borderRadius,
    }));
    expect(size.w).toBe("18px");
    expect(size.h).toBe("18px");
    expect(size.radius).toBe("5px");

    // 硬性禁止格：整格底 #f8fafc。
    const hardDenied = page.locator('[data-testid="role-matrix-checkbox"][data-hard-denied="1"]').first();
    await expect(hardDenied).toHaveCount(1);
    const cellBg = await hardDenied.evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
    expect(cellBg).toBe("rgb(248, 250, 252)"); // #f8fafc

    await shoot(page, "17-roles-1440");
    await page.setViewportSize({ width: 375, height: 812 });
    await shoot(page, "17-roles-375");
  });

  test("(3) 操作紀錄：pill 樣式", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, "老闆");
    await page.goto("/audit-log");

    await expect(page.getByTestId("audit-log-row").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("audit-log-action-pill").first()).toBeVisible();

    // M1：揀「最近 7 日」→ 請求 URL 帶 from/to（正路 server-side 篩，
    // 唔再係前端假篩），總數（分頁 caption）會變（呢個 dev DB 有跨越
    // 7 日以上嘅操作紀錄，「全部」總數一定 ≥「最近 7 日」總數）。
    const totalCaptionBefore = await page.locator("text=/共 \\d+ 條/").innerText();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/audit-log?") && r.url().includes("from=") && r.url().includes("to=")),
      page.getByTestId("audit-log-date-filter").selectOption({ label: "最近 7 日" }),
    ]);
    expect(request.url()).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(request.url()).toMatch(/to=\d{4}-\d{2}-\d{2}/);
    await expect(page.locator("text=/共 \\d+ 條/")).toBeVisible();
    const totalCaptionAfter = await page.locator("text=/共 \\d+ 條/").innerText();
    const numOf = (s: string) => Number(/共 (\d+) 條/.exec(s)?.[1] ?? "-1");
    expect(numOf(totalCaptionAfter)).toBeLessThanOrEqual(numOf(totalCaptionBefore));
    expect(numOf(totalCaptionBefore)).toBeGreaterThan(0);

    await shoot(page, "18-audit-log-1440");
    await page.setViewportSize({ width: 375, height: 812 });
    await shoot(page, "18-audit-log-375");
  });

  test("(4) 改密碼：強度條隨輸入變（唔提交，唔改真密碼）", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, "老闆");
    await page.goto("/change-password");

    const strengthBar = page.getByTestId("change-password-strength");
    await expect(strengthBar).toBeVisible({ timeout: 15_000 });
    await expect(strengthBar).toHaveAttribute("data-strength", "0");

    const newPwd = page.getByTestId("change-password-new");
    await newPwd.fill("abc");
    await expect(strengthBar).toHaveAttribute("data-strength", "0");

    await newPwd.fill("abcdefgh"); // ≥8 位但冇數字
    await expect(strengthBar).toHaveAttribute("data-strength", "1");

    await newPwd.fill("Abcdefgh12"); // ≥8 位＋字母＋數字＋大小寫
    await expect(strengthBar).toHaveAttribute("data-strength", "3");

    // 清返走，確保呢個 test 完全冇撳「更新密碼」——冇動過真帳號密碼。
    await newPwd.fill("");
    await page.getByTestId("change-password-old").fill("");
    await page.getByTestId("change-password-confirm").fill("");

    await shoot(page, "20-change-password-1440");
    await page.setViewportSize({ width: 375, height: 812 });
    await shoot(page, "20-change-password-375");
  });

  test("(5) 在勤助手：歡迎語 chips 三句", async ({ page }) => {
    // 老闆呢個測試帳號同 ai.spec.ts 共用同一條 ai_conversations 記錄——
    // 清走先至保證見到「歡迎語」（冇記錄先顯示），同 ai.spec.ts 做法一致。
    await clearAiConversationForTel(TEST_TEL.老闆);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, "老闆");
    await page.goto("/roster");

    await page.getByTestId("ai-assistant-tab").click();
    await expect(page.getByTestId("ai-welcome")).toBeVisible({ timeout: 20_000 });

    const chips = page.getByTestId("ai-example-button");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveText("今日邊個盤未夠人");
    await expect(chips.nth(1)).toHaveText("7 月毛利率最低 5 個盤");
    await expect(chips.nth(2)).toHaveText("公司兵本月幾多 RD");
    // 第三句唔准出現內部雞頭代號（B07 呢類）。
    for (const c of ["B07", "B09", "B10"]) {
      await expect(chips.nth(2)).not.toContainText(c);
    }

    await shoot(page, "19-ai-assistant-1440");
  });

  test.afterAll(async () => {
    await prisma.$disconnect();
  });
});
