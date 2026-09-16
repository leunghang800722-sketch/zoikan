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
  const brokerDId = await findBrokerIdByCode("K"); // 啟航1331 有 K（淦）嘅更；D 冇

  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  // 2026-08 喺 dev DB 唔一定有記錄（seed 只有 7 月；8 月係 e2e 自己造嘅，
  // 其他 gate 跑完會清走）——冇行就先「複製上月」，儲存嗰下會一齊計价。
  const copyBtn = page.getByRole("button", { name: /複製上月/ });
  await expect(copyBtn).toBeVisible({ timeout: 20_000 });
  if ((await page.getByTestId("roster-row").count()) === 0) {
    await copyBtn.click();
  }
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

  // 揀一行 settlement_broker=D 嘅記錄（冇就跳過呢個場景嘅精確斷言，淨係
  // 靠儲存後 pricing.priced>0 呢個較弱嘅斷言）——搵返一個 D 嘅 row index。
  const dRow = await prisma.shiftRecord.findFirst({
    where: { siteId, settlementBrokerId: brokerDId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" },
    include: { guard: true, shiftType: true },
  });

  {
    const row = dRow ? page.locator(`tr[data-row-key="${dRow.shiftTypeId}|${dRow.guardId}"]`).first() : page.getByTestId("roster-row").first();
    const rowCount = await row.count();
    const targetRow = rowCount > 0 ? row : page.getByTestId("roster-row").first();
    const rowIndex = Number(await targetRow.getAttribute("data-row-index"));
    const cell = page.getByTestId(`roster-cell-${rowIndex}-20`);
    await cell.click();
    // 修正（本輪跑 e2e 發現）：`dRow` 淨係查緊 DB（真正儲存咗嘅記錄）——
    // 「複製上月」淨係喺瀏覽器記憶體 dirty 咗（未儲存前 DB 完全冇 8 月
    // 記錄），所以第一次喺一個乾淨嘅 8 月跑呢個 test，`dRow` 100% 係
    // null，跌落 `getByTestId("roster-row").first()` 呢條 fallback——
    // 之前呢度不論 fallback 揀到邊一行都硬打字面 "D"，如果第一行剛好
    // 唔係 D 更（例如 IC/N/SIC）就即刻撞「同呢行嘅更別代號都對唔上」。
    // 而家改用 `targetRow` 自己嘅 `data-row-key`（`${shift_type_id}|
    // ${guard_id}`）查返呢一行*真正*嘅更別代號，先至保證打嘅字同行一定夾。
    const rowKey = await targetRow.getAttribute("data-row-key");
    const rowShiftTypeId = rowKey?.split("|")[0];
    const rowShiftType = rowShiftTypeId ? await prisma.shiftType.findUnique({ where: { id: rowShiftTypeId } }) : null;
    const shiftCode = dRow?.shiftType.code ?? rowShiftType?.code ?? "D";
    const current = ((await cell.textContent()) ?? "").trim();
    const toType = current === shiftCode ? "AL" : shiftCode;
    await page.keyboard.type(toType);
    await page.keyboard.press("Enter");
    await expect(cell).toHaveText(toType);
  }

  await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
  const toast = page.getByTestId("roster-save-toast");
  await expect(toast).toBeVisible({ timeout: 30_000 });
  // WP-PRICE：呢次填嘅係已有卡嘅組合，toast 應該係「已儲存」（唔帶
  // 「未定价」字眼）——證明 batch/route.ts 真係計咗价（唔係靜靜 0）。
  // toast 3 秒後自動收，所以一見到就即刻讀文字，唔好再等第二次 locator。
  const toastText = (await toast.textContent().catch(() => "")) ?? "";
  expect(toastText).not.toContain("未定价");
  expect(toastText).not.toContain("未定價");

  // 糧明細係財務頁（老闆／會計先有 view），主管開會 403——換老闆登入睇。
  await page.goto("/login");
  await loginAs(page, "老闆");
  await page.goto("/reports/payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await expect(page.getByText("K", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  // 逐行揾返 D 嗰行，金額 > 0（PDPO：唔斷言真名，淨係用代號 D）。
  const dPayrollRow = page.locator("tr", { has: page.getByText("K", { exact: true }) }).first();
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

  // 空預覽（自給自足，唔靠其他 test 剩低嘅狀態）。淨係揀 billing_model=
  // per_shift 嘅卡——M1（Opus 驗收）之後 resolver 淨係逐更卡先可以做
  // 逐更 snapshot，special/monthly_fixed 嘅「成個月總額」卡（例如
  // 啟航1331 Event Guard $11,700）改咗都唔會令任何一條 shift_record 嘅
  // client_rate 變（resolver 完全唔揀呢類卡），揀錯就會令 dry-run 預覽
  // changed=0，同呢個 test 嘅假設唔夾。
  const cards = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null, clientRate: { not: null }, billingModel: "per_shift" } });
  if (cards.length === 0) throw new Error("e2e (c)：搵唔到啟航1331任何有 client_rate 嘅 per_shift 卡做基準");
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

// 必修 1（Opus 第二輪驗收）：code="PR"（糧明細生成 reconciliation
// placeholder）更別已經封死——(d) 「複製上月」唔可以將 7 月 PR 記錄原封
// 搬入 8 月（RosterEditor.tsx handleCopyPrevMonth skip 邏輯）；(e) batch
// API 對 code="PR" 新建一律 400（batch/route.ts）。用 TKO Gateway 厚A——
// dev DB seed 咗 25 條 7 月 PR 記錄（settlement broker K），冇任何盤
// 更適合做呢個場景嘅基準。

test("(d) 「複製上月」略過 PR：TKO Gateway 厚A 7 月有 25 條 PR 記錄，複製上月唔會將 PR 帶入 8 月＋提示已略過幾行", async ({ page }) => {
  const siteId = await findSiteIdByName("TKO Gateway 厚A");
  const prShiftType = await prisma.shiftType.findFirstOrThrow({ where: { siteId, code: "PR" } });

  // 自給自足：先確認 8 月呢個盤完全冇 PR 記錄（batch 已經 400 咗新建，
  // 理論上永遠唔會有——呢度純粹防禦性斷言，唔係呢個 test 自己整嘅）。
  const augPrBefore = await prisma.shiftRecord.count({
    where: { shiftTypeId: prShiftType.id, workDate: { gte: AUG, lte: AUG_END } },
  });
  expect(augPrBefore).toBe(0);

  const dialogMessages: string[] = [];
  page.on("dialog", (d) => {
    dialogMessages.push(d.message());
    d.accept();
  });

  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  const copyBtn = page.getByRole("button", { name: /複製上月/ }).first();
  await expect(copyBtn).toBeVisible({ timeout: 20_000 });
  await copyBtn.click();

  // handleCopyPrevMonth() 純前端 cells/extraRows 狀態變更，冇撳「儲存」
  // 前乜都唔會寫落 DB——等 alert() 講「已略過 N 行對數佔位更別」出現。
  await expect(async () => {
    expect(dialogMessages.some((m) => m.includes("已略過") && m.includes("對數佔位更別"))).toBe(true);
  }).toPass({ timeout: 15_000 });

  // 格仔層面都要驗證：PR 呢一行（shift_type_id=prShiftType.id）唔應該
  // 出現喺畫面（`data-row-key` 以 `${prShiftType.id}|` 開頭嘅 row 一個
  // 都冇）——證明真係跳過咗，唔係得個提示冧巴啱但實際上仍然帶咗入嚟。
  const prRowLocator = page.locator(`tr[data-row-key^="${prShiftType.id}|"]`);
  await expect(prRowLocator).toHaveCount(0);

  // 冇撳「儲存」，DB 應該完全冇變——雙重確認（唔淨係信賴前端冇整污染）。
  const augPrAfter = await prisma.shiftRecord.count({
    where: { shiftTypeId: prShiftType.id, workDate: { gte: AUG, lte: AUG_END } },
  });
  expect(augPrAfter).toBe(0);
});

test("(e) 新建 PR 記錄 → batch/route.ts 400（PR 已封死，唔可以排更）", async ({ page }) => {
  const siteId = await findSiteIdByName("TKO Gateway 厚A");
  const prShiftType = await prisma.shiftType.findFirstOrThrow({ where: { siteId, code: "PR" } });
  const prRecord = await prisma.shiftRecord.findFirstOrThrow({ where: { shiftTypeId: prShiftType.id, recordType: "shift" } });

  await loginAs(page, "主管");

  // 直接打 batch API（唔經 UI——加保安員／複製上月嘅更別選項已經剔走
  // PR，UI 冇路徑可以整到呢個 payload，但 API 本身要獨立守住，防止繞過
  // 前端直接打 API）。揀一個 8 月未存在呢個組合嘅日期。
  const res = await page.request.post("/api/shift-records/batch", {
    data: {
      site_id: siteId,
      month: "2026-08",
      cells: [
        {
          guard_id: prRecord.guardId,
          shift_type_id: prShiftType.id,
          work_date: "2026-08-20",
          code: "PR",
          settlement_broker_id: prRecord.settlementBrokerId,
        },
      ],
    },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(JSON.stringify(body)).toMatch(/對數佔位更別/);

  // 確認真係乜都冇寫入。
  const created = await prisma.shiftRecord.findFirst({
    where: { shiftTypeId: prShiftType.id, workDate: new Date(Date.UTC(2026, 7, 20)) },
  });
  expect(created).toBeNull();

  // 單條 POST /api/shift-records（內部角色路徑）都要一致守住。
  const res2 = await page.request.post("/api/shift-records", {
    data: {
      work_date: "2026-08-21",
      site_id: siteId,
      shift_type_id: prShiftType.id,
      guard_id: prRecord.guardId,
      settlement_broker_id: prRecord.settlementBrokerId,
      record_type: "shift",
    },
  });
  expect(res2.status()).toBe(400);
});
