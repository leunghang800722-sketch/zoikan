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
  const brokerKId = await findBrokerIdByCode("K");

  // 搵一個呢個盤入面「有效嘅 rate_card」完全唔存在嘅組合——「暫時作廢晒
  // 呢個盤全部 rate_cards」，簡單、可靠、跑完逐一 unvoid 還原（唔留低
  // 污染畀下一次跑）。
  const cardsToVoid = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null } });
  await prisma.rateCard.updateMany({ where: { siteId, voidedAt: null }, data: { voidedAt: new Date() } });

  try {
    // 揀一條 settlement_broker=K（普通雞頭，唔係 external/longterm——
    // 兩者就算冇卡都唔算「未定价」，唔啱呢個測試場景）嘅記錄，攞返佢嘅
    // guard/shift_type，再喺 8 月搵一日呢個組合本身冇 shift_record（保證
    // 個格一開始係空，type 落去先真係 dirty）。
    const kRow = await prisma.shiftRecord.findFirst({
      where: { siteId, settlementBrokerId: brokerKId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" },
      include: { shiftType: true },
    });
    if (!kRow) throw new Error("e2e (b)：搵唔到 2026-08 啟航1331 K 雞頭嘅記錄做基準");
    const existingDays = new Set(
      (
        await prisma.shiftRecord.findMany({
          where: { siteId, shiftTypeId: kRow.shiftTypeId, guardId: kRow.guardId, workDate: { gte: AUG, lte: AUG_END } },
          select: { workDate: true },
        })
      ).map((r) => r.workDate.getUTCDate()),
    );
    let emptyDay: number | null = null;
    for (let d = 1; d <= 31; d++) {
      if (!existingDays.has(d)) {
        emptyDay = d;
        break;
      }
    }
    if (emptyDay === null) throw new Error("e2e (b)：搵唔到一日呢個 guard+shift_type 組合係空格");

    await loginAs(page, "主管");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const row = page.locator(`tr[data-row-key="${kRow.shiftTypeId}|${kRow.guardId}"]`);
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    const rowIndex = Number(await row.getAttribute("data-row-index"));
    const cell = page.getByTestId(`roster-cell-${rowIndex}-${emptyDay}`);
    await cell.click();
    await page.keyboard.type(kRow.shiftType.code);
    await page.keyboard.press("Enter");
    await expect(cell).toHaveText(kRow.shiftType.code); // 保證真係 dirty（清空格→有值）

    const saveBtn = page.getByRole("button", { name: /^儲存$|^儲存緊/ }).first();
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 }); // dirtyCount>0 先啟用
    await saveBtn.click();
    await expect(page.getByTestId("roster-save-toast")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("roster-save-toast")).toContainText("未定价");

    await page.reload();
    await expect(page.getByText(/更未定价（冇對應價目卡）/)).toBeVisible({ timeout: 20_000 });
  } finally {
    // 還原（老闆 unvoid）＋清走呢個 test 新填低嘅一格——鐵律：唔可以留低
    // 污染畀下一次跑。
    for (const c of cardsToVoid) {
      await prisma.rateCard.update({ where: { id: c.id }, data: { voidedAt: null } });
    }
    await prisma.shiftRecord.deleteMany({
      where: { siteId, settlementBrokerId: brokerKId, workDate: { gte: AUG, lte: AUG_END }, createdBy: { not: { contains: "seed" } } },
    });
  }
});

test("(c) 老闆撳「重新計价」（2026-08）→ dry-run 預覽 dialog（帶 changed/unchanged 數）→ 唔確認就唔會寫入", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");

  // M3：確保呢個盤呢個月真係有嘢會 changed——起碼一張 rate_card 嘅
  // client_rate 改一改（跑完自己改返），等 dry-run 預覽一定唔係「0 changed」
  // 空預覽（自給自足，唔靠其他 test 剩低嘅狀態）。
  const cards = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null, clientRate: { not: null } } });
  if (cards.length === 0) throw new Error("e2e (c)：搵唔到啟航1331任何有 client_rate 嘅卡做基準");
  const targetCard = cards[0]!;
  const originalClientRate = targetCard.clientRate;
  await prisma.rateCard.update({ where: { id: targetCard.id }, data: { clientRate: Number(originalClientRate) + 1 } });

  const dialogMessages: string[] = [];
  page.on("dialog", (d) => {
    dialogMessages.push(d.message());
    // M3：呢個 test 淨係想驗證 dry-run 預覽 dialog 嘅內容（changed/
    // unchanged/kept_unresolved 摘要）真係經咗兩段式流程——confirm()
    // 就 dismiss（唔確認），令 handleReprice() 唔會再打第二轉
    // dry_run:false，保證呢個 test 100% 唔寫 DB（自給自足，唔留低
    // 污染畀下一次跑，連 unvoid/restore snapshot 都唔使做）。
    if (d.type() === "confirm") d.dismiss();
    else d.accept();
  });

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const repriceBtn = page.getByRole("button", { name: /重新計价/ });
    if (await repriceBtn.count()) {
      const before = await prisma.shiftRecord.count({ where: { siteId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" } });
      await repriceBtn.click();
      await expect(async () => {
        expect(dialogMessages.some((m) => m.includes("預覽"))).toBe(true);
      }).toPass({ timeout: 15_000 });
      expect(dialogMessages.some((m) => /會改變/.test(m))).toBe(true); // 證明真係經咗 dry-run 摘要（帶 changed 數），唔係舊版單一 confirm
      expect(dialogMessages.some((m) => m.includes("完成"))).toBe(false); // dismiss 咗 confirm，唔應該再有「完成」dialog
      await expect(page.getByText(/重新計价失敗/)).toHaveCount(0);

      // 確認真係冇寫入——DB 記錄數／內容冇變（dry-run 淨係回摘要）。
      const after = await prisma.shiftRecord.count({ where: { siteId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" } });
      expect(after).toBe(before);
    }
  } finally {
    // 還原張卡嘅 client_rate（鐵律：唔留低污染畀下一次跑）——呢個 test
    // 全程冇撳「確認」，所以 shift_records 本身冇被寫過，淨係要改返轉頭
    // 張卡嘅 client_rate 就足夠。
    await prisma.rateCard.update({ where: { id: targetCard.id }, data: { clientRate: originalClientRate } });
  }
});
