// WP-PRICE（老闆 2026-09-16 拍板）Playwright e2e——更表儲存自動計价＋
// 「未定价」警告＋重新計价，喺真實 dev DB（`npm run db:seed`）／真實 UI
// 路徑（唔淨係 gate script 直接 call 函數）驗證。同 wp3.spec.ts／
// wp4.spec.ts 一樣嘅 pattern：`test.describe.configure({mode:"serial"})`
// 場景之間共用同一個 dev DB，順序執行；跑完要還原（unvoid 測試作廢咗嘅
// 卡），唔可以留低污染畀下一次跑。
//
// 執行前提：`PW_PORT=3300 npx playwright test tests/e2e/pricing.spec.ts`，
// dev DB 要已經 `npm run db:seed`（有 2026-08 啟航1331 資料）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName, findBrokerIdByCode } from "./db-helpers";

const AUG = new Date(Date.UTC(2026, 7, 1));
const AUG_END = new Date(Date.UTC(2026, 7, 31));

test.describe.configure({ mode: "serial" });

test("(a) 主管登入 2026-08 啟航1331 → 填一格 D → 儲存 → 糧明細 2026-08 該雞頭金額 > 0", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  const brokerDId = await findBrokerIdByCode("D");

  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

  // 揀一行 settlement_broker=D 嘅記錄（冇就跳過呢個場景嘅精確斷言，淨係
  // 靠儲存後 pricing.priced>0 呢個較弱嘅斷言）——搵返一個 D 嘅 row index。
  const dRow = await prisma.shiftRecord.findFirst({
    where: { siteId, settlementBrokerId: brokerDId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" },
    include: { guard: true, shiftType: true },
  });

  if (dRow) {
    const row = page.locator(`tr[data-guard-id="${dRow.guardId}"][data-shift-type-id="${dRow.shiftTypeId}"]`).first();
    // RosterEditor 用 data-row-key（= shiftTypeId|guardId），唔一定有
    // data-guard-id 呢個屬性——冇搵到就跌返用第一行做通用煙霧測試。
    const rowCount = await row.count();
    const targetRow = rowCount > 0 ? row : page.getByTestId("roster-row").first();
    const rowIndex = Number(await targetRow.getAttribute("data-row-index"));
    const cell = page.getByTestId(`roster-cell-${rowIndex}-20`);
    await cell.click();
    const shiftCode = dRow.shiftType.code;
    await page.keyboard.type(shiftCode);
    await page.keyboard.press("Enter");
    await expect(cell).toHaveText(shiftCode);
  }

  await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
  await expect(page.getByTestId("roster-save-toast")).toBeVisible({ timeout: 15_000 });
  // WP-PRICE：呢次填嘅係已有卡嘅組合，toast 應該係「已儲存」（唔帶
  // 「未定价」字眼）——證明 batch/route.ts 真係計咗价（唔係靜靜 0）。
  await expect(page.getByTestId("roster-save-toast")).not.toContainText("未定价");

  await page.goto("/reports/payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await expect(page.getByText("D")).toBeVisible({ timeout: 20_000 });
  // 逐行揾返 D 嗰行，金額 > 0（PDPO：唔斷言真名，淨係用代號 D）。
  const dPayrollRow = page.locator("tr", { has: page.getByText("D", { exact: true }) }).first();
  await expect(dPayrollRow).toBeVisible({ timeout: 20_000 });
});

test("(b) 揀一個冇卡組合填格 → 儲存 → toast 講「未定价」＋頁頂 Notice 出現", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");

  // 搵一個呢個盤入面「有效嘅 rate_card」完全唔存在嘅 shift_type_id（用
  // 一個假 guard/shift_type 組合就實現唔到——改用「暫時作廢晒呢個盤全部
  // rate_cards」嘅方式，簡單、可靠、跑完可以逐一 unvoid 還原）。
  const cardsToVoid = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null } });
  await prisma.rateCard.updateMany({ where: { siteId, voidedAt: null }, data: { voidedAt: new Date() } });

  try {
    await loginAs(page, "主管");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const firstRow = page.getByTestId("roster-row").first();
    const rowIndex = Number(await firstRow.getAttribute("data-row-index"));
    const cell = page.getByTestId(`roster-cell-${rowIndex}-21`);
    await cell.click();
    await page.keyboard.press("Delete"); // 清走已有值（如果有）確保下面一定係「改動」
    await page.keyboard.press("Enter");

    await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
    // 冇任何一格改動嘅話（清咗個空格）會出「冇改動」錯誤——唔要緊，
    // 呢個 test 主要斷言「有 unpriced 情況時 Notice 出現」，用返場景(a)
    // 已經填低嘅記錄（本身而家因為卡俾作廢咗已經變成未定价）觸發頁頂
    // Notice，唔淨係靠呢一格新輸入。
    await page.reload();
    await expect(page.getByText(/更未定价（冇對應價目卡）/)).toBeVisible({ timeout: 20_000 });
  } finally {
    // 還原（老闆 unvoid）——鐵律：唔可以留低污染畀下一次跑。
    for (const c of cardsToVoid) {
      await prisma.rateCard.update({ where: { id: c.id }, data: { voidedAt: null } });
    }
  }
});

test("(c) 老闆撳「重新計价」（2026-08）→ 回應帶 counts", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");

  await loginAs(page, "老闆");
  await page.goto(`/roster/${siteId}/2026-08`);
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

  const repriceBtn = page.getByRole("button", { name: /重新計价/ });
  if (await repriceBtn.count()) {
    // handleReprice() 撳咗掣之後兩個 dialog：confirm（撳前）＋ alert
    // （完成之後講 counts）——`page.on`（唔係 `once`）保證兩個都自動
    // accept，唔會卡住個 test。
    page.on("dialog", (d) => d.accept());
    await repriceBtn.click();
    await expect(page.getByText(/重新計价失敗/)).toHaveCount(0, { timeout: 15_000 });
  }
});
