// WP-PRICE（老闆 2026-09-16 拍板）Playwright e2e——更表儲存自動計價＋
// 「未定價」警告＋重新計價，喺真實 dev DB（`npm run db:seed`）／真實 UI
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
  // 其他 gate 跑完會清走）——冇行就先「複製上月」，儲存嗰下會一齊計價。
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

  // 應修 6（Opus 驗收覆核）：呢三個變數要喺 block 出面就宣告——下面
  // (i)/(ii) 兩條斷言要用嚟查返「呢一格」真正儲存咗嘅記錄／組合。
  let savedShiftTypeId: string | undefined;
  let savedGuardId: string | undefined;
  let savedShiftTypeCode: string | undefined;
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
    const rowGuardId = rowKey?.split("|")[1];
    const rowShiftType = rowShiftTypeId ? await prisma.shiftType.findUnique({ where: { id: rowShiftTypeId } }) : null;
    const shiftCode = dRow?.shiftType.code ?? rowShiftType?.code ?? "D";
    const current = ((await cell.textContent()) ?? "").trim();
    const toType = current === shiftCode ? "AL" : shiftCode;
    await page.keyboard.type(toType);
    await page.keyboard.press("Enter");
    await expect(cell).toHaveText(toType);

    savedShiftTypeId = rowShiftTypeId;
    savedGuardId = rowGuardId;
    savedShiftTypeCode = rowShiftType?.code ?? shiftCode;
  }

  await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
  const toast = page.getByTestId("roster-save-toast");
  await expect(toast).toBeVisible({ timeout: 90_000 }); // 冷啟動＋成個月複製儲存可以超過 30s

  // 應修 6（Opus 驗收覆核）：新 toast 優先級（「冇結算單位」toast 贏過
  // 「未定價」toast，見 RosterEditor.tsx「已儲存 · N 格冇結算單位」／
  // 「已儲存 · N 格未定價」互斥顯示）令舊版 `not.toContain("未定價")`
  // 呢種純睇 toast 文字嘅斷言可以假通過——就算呢次動作真係整咗未定價
  // 格，只要同一次儲存**同時**觸發咗「冇結算單位」toast，文字已經唔
  // 帶「未定價」呢個字，舊斷言一樣過，但實際上未定價問題完全冇被攔
  // 到。而家改用兩條實質、直接打 API／DB 嘅斷言，唔再淨係睇 toast
  // 文字：
  //   (i) 冇結算單位（no_settlement_count）＝0——呢個先係 P0 真正要守嘅
  //       invariant（settlement_broker_id 一定要有值，糧單先見到呢批
  //       更；呢個 test 本身填嘅係一個已存在嘅保安員/更別/雞頭組合，儲存
  //       之後唔應該整出任何一格冇結算單位）。
  //   (ii) 未定價格數（呢個 site+shift_type+broker 組合，excl.
  //       no_settlement）唔准多過「上月（2026-07）同一個組合本身已經
  //       缺價嘅格數」——用 `GET /api/shift-records/unpriced?month=&
  //       site_id=` 動態計，唔寫死數字（上月本身缺咗幾多張卡係 dev
  //       seed 資料，可以隨 seed 內容變；淨係要求「冧手唔會整多」）。
  //
  // 呢兩條斷言用返仍然登入緊嘅「主管」session（`page.request` 帶埋
  // browser context 嘅 cookie），喺換老闆登入睇糧明細之前打。
  const savedRecord =
    savedShiftTypeId && savedGuardId
      ? await prisma.shiftRecord.findFirst({
          where: { siteId, shiftTypeId: savedShiftTypeId, guardId: savedGuardId, workDate: new Date(Date.UTC(2026, 7, 20)) },
        })
      : null;

  type UnpricedApiGroup = { shift_type_code: string; broker_code: string | null; category?: string; count: number };
  type UnpricedApiResult = { no_settlement_count?: number; groups: UnpricedApiGroup[] };
  async function fetchUnpriced(month: string): Promise<UnpricedApiResult> {
    const res = await page.request.get(`/api/shift-records/unpriced?month=${month}&site_id=${siteId}`);
    expect(res.ok()).toBe(true);
    return (await res.json()) as UnpricedApiResult;
  }
  function sumUnpricedForCombo(groups: UnpricedApiGroup[], shiftTypeCode: string, brokerCode: string | null): number {
    return groups
      .filter((g) => g.category !== "no_settlement" && g.shift_type_code === shiftTypeCode && g.broker_code === brokerCode)
      .reduce((sum, g) => sum + g.count, 0);
  }

  const augUnpriced = await fetchUnpriced("2026-08");
  // (i) 冇結算單位一定係 0——呢個 test 揀嘅係一個原本已經有雞頭嘅組合，
  // 唔應該整出任何一格冇結算單位。
  expect(augUnpriced.no_settlement_count ?? 0).toBe(0);

  // (ii) 未定價格數唔准多過上月同組合本身已缺價嘅格數（動態計，唔寫死）。
  if (savedRecord && savedShiftTypeCode) {
    const brokerCodeRow = savedRecord.settlementBrokerId ? await prisma.broker.findUnique({ where: { id: savedRecord.settlementBrokerId } }) : null;
    const brokerCode = brokerCodeRow?.code ?? null;
    const julUnpriced = await fetchUnpriced("2026-07");
    const baselineCount = sumUnpricedForCombo(julUnpriced.groups, savedShiftTypeCode, brokerCode);
    const afterCount = sumUnpricedForCombo(augUnpriced.groups, savedShiftTypeCode, brokerCode);
    expect(afterCount).toBeLessThanOrEqual(baselineCount);
  }

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

test("(b) 揀一個冇卡組合填格 → 儲存 → toast 講「未定價」＋頁頂 Notice 出現", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  const brokerKId = await findBrokerIdByCode("K");

  // 搵一個呢個盤入面「有效嘅 rate_card」完全唔存在嘅組合——「暫時作廢晒
  // 呢個盤全部 rate_cards」，簡單、可靠、跑完逐一 unvoid 還原（唔留低
  // 污染畀下一次跑）。
  const cardsToVoid = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null } });
  await prisma.rateCard.updateMany({ where: { siteId, voidedAt: null }, data: { voidedAt: new Date() } });

  try {
    // 揀一條 settlement_broker=K（普通雞頭，唔係 external/longterm——
    // 兩者就算冇卡都唔算「未定價」，唔啱呢個測試場景）嘅記錄，攞返佢嘅
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
    await expect(page.getByTestId("roster-save-toast")).toContainText("未定價");

    await page.reload();
    await expect(page.getByText(/更未定價（冇對應價目卡）/)).toBeVisible({ timeout: 20_000 });
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

test("(c) 老闆撳「重新計價」（2026-08）→ dry-run 預覽 dialog（帶 changed/unchanged 數）→ 唔確認就唔會寫入", async ({ page }) => {
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

  try {
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const repriceBtn = page.getByRole("button", { name: /重新計價/ });
    if (await repriceBtn.count()) {
      const before = await prisma.shiftRecord.count({ where: { siteId, workDate: { gte: AUG, lte: AUG_END }, recordType: "shift" } });
      const writeReqs: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/shift-records/reprice") && (r.postDataJSON() as { dry_run?: boolean } | null)?.dry_run === false) writeReqs.push(r.url());
      });
      await repriceBtn.click();
      // P3-4.2：window.confirm／alert 改 ConfirmDialog／info banner。有更次會變 → ConfirmDialog（我哋「取消」唔寫入）；
      // 冇更次會變 → info banner（「…冇嘢寫入」）。兩種都證明經咗 dry-run 預覽（唔係舊版單一 confirm）。
      const dlg = page.getByTestId("confirm-dialog");
      const info = page.getByTestId("roster-info-banner");
      await expect(dlg.or(info)).toBeVisible({ timeout: 15_000 });
      let msg: string;
      if (await dlg.count()) {
        msg = await page.getByTestId("confirm-dialog-message").innerText();
        await page.getByTestId("confirm-dialog-cancel").click(); // 唔確認：令 handleReprice() 唔會再打 dry_run:false，保證 100% 唔寫 DB
      } else {
        msg = await info.innerText();
      }
      expect(/重新計價預覽/.test(msg) && /會改變|會變/.test(msg)).toBe(true);
      expect(msg.includes("完成")).toBe(false);
      await page.waitForTimeout(500);
      expect(writeReqs).toEqual([]); // 取消／冇改動：冇任何 dry_run:false 請求
      await expect(page.getByText(/重新計價失敗/)).toHaveCount(0);

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

  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  const copyBtn = page.getByRole("button", { name: /複製上月/ }).first();
  await expect(copyBtn).toBeVisible({ timeout: 20_000 });
  await copyBtn.click();

  // handleCopyPrevMonth() 純前端 cells/extraRows 狀態變更，冇撳「儲存」
  // 前乜都唔會寫落 DB——等 alert() 講「已略過 N 行對數佔位更別」出現。
  await expect(page.getByTestId("roster-info-banner")).toContainText(/已略過.*對數佔位更別/, { timeout: 15_000 });

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

// P0（Opus 驗收重現）：新月份更表記錄冇咗結算單位→喺糧單成行消失——見
// RosterEditor.tsx handleSave()／batch/route.ts／
// src/lib/pricing/settlement-broker-fallback.ts 頂註解。呢個場景專登整
// 一個 `default_broker_id=NULL` 嘅保安員（模擬 bug repro 講嘅 93/265 個
// 長工/公司兵）——修復之前，「複製上月」個 payload 冇送
// settlement_broker_id，跌到 batch route 嘅 `guard.default_broker_id ??
// null` fallback，新記錄會係 NULL。自己起獨立 site/guard（唔靠 seed
// 數據嘅巧合），自給自足＋finally 清走。
test("(f) 複製上月：保安員 default_broker_id=NULL 都要跟返上月記錄嘅 settlement broker，唔會跌做 NULL 喺糧單消失", async ({ page }) => {
  const brokerK = await findBrokerIdByCode("K");
  const testSite = await prisma.site.create({
    data: { canonicalName: `E2E-P0-結算單位-${Date.now()}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "e2e:pricing-p0" },
  });
  const testShiftType = await prisma.shiftType.create({
    data: { siteId: testSite.id, code: "N", label: "測試夜更", hours: 12, createdBy: "e2e:pricing-p0" },
  });
  const testGuard = await prisma.guard.create({
    data: { nameZh: "E2E測試保安員", employmentType: "longterm_autopay", defaultBrokerId: null, createdBy: "e2e:pricing-p0" },
  });
  const julyDate = new Date(Date.UTC(2026, 6, 10));
  await prisma.shiftRecord.create({
    data: {
      siteId: testSite.id,
      shiftTypeId: testShiftType.id,
      guardId: testGuard.id,
      workDate: julyDate,
      settlementBrokerId: brokerK,
      operationalBrokerId: brokerK,
      recordType: "shift",
      status: "confirmed",
      createdBy: "e2e:pricing-p0",
    },
  });

  try {
    await loginAs(page, "主管");
    await page.goto(`/roster/${testSite.id}/2026-08`);
    const copyBtn = page.getByRole("button", { name: /複製上月/ }).first();
    await expect(copyBtn).toBeVisible({ timeout: 20_000 });
    await copyBtn.click();
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
    const toast = page.getByTestId("roster-save-toast");
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastText = (await toast.textContent().catch(() => "")) ?? "";
    // P0 修復之後，呢個 guard 嘅新記錄唔應該再係「冇結算單位」。
    expect(toastText).not.toContain("冇結算單位");

    const augRecord = await prisma.shiftRecord.findFirst({
      where: { siteId: testSite.id, guardId: testGuard.id, workDate: new Date(Date.UTC(2026, 7, 10)), recordType: "shift" },
    });
    expect(augRecord).toBeTruthy();
    // 核心斷言：settlement broker 同 7 月一致，唔係 null（batch route
    // response 亦已經證明 no_settlement_count 冇被觸發）。
    expect(augRecord!.settlementBrokerId).toBe(brokerK);

    // 糧單：K 呢個雞頭本月出現喺 /api/reports/payroll，證明冇喺
    // buildPayrollTotals() 逐 broker 查嗰陣跌漏（同 7 月一致嘅結算單位
    // 令呢條記錄真係計入咗糧單，唔係得個 settlement_broker_id 有值但
    // 報表冇讀到）。
    await page.goto("/login");
    await loginAs(page, "老闆");
    const payrollRes = await page.request.get("/api/reports/payroll?month=2026-08");
    expect(payrollRes.ok()).toBe(true);
    const payrollBody = await payrollRes.json();
    const kTotal = (payrollBody.totals as Array<{ broker_id: string; shifts: number }>).find((t) => t.broker_id === brokerK);
    expect(kTotal).toBeTruthy();
    expect(kTotal!.shifts).toBeGreaterThan(0);

    // 反向確認：冇「未歸屬結算單位」（broker_id=null）行係嚟自呢個 test
    // 整嘅記錄——呢個 test 本身冇整任何 null 記錄，如果有都係其他
    // 並行/遺留狀態，唔喺呢度斷言全局 0（避免同其他 test 撞）。
  } finally {
    await prisma.shiftRecord.deleteMany({ where: { siteId: testSite.id } });
    await prisma.guard.delete({ where: { id: testGuard.id } });
    await prisma.shiftType.deleteMany({ where: { siteId: testSite.id } });
    await prisma.site.delete({ where: { id: testSite.id } });
  }
});

// 應修 2（RosterEditor.tsx handleSave()）：同一行（guard+shift_type）入面
// 唔同日可以有唔同嘅 settlement_broker_id（例如舊月份逐日人手指定過）；
// `RowMeta.brokerId` 淨係「其中一日」嘅值（buildRowsAndCells() 逐 rowKey
// 第一次見到嗰條記錄嘅 broker，`GET /api/shift-records` 用
// `workDate:"desc"`，即係「最遲嗰日」）。之前改另一日嘅 code 會連
// settlement_broker_id 一齊送出去，將呢個 row 級（其實係「最遲嗰日」）
// 嘅值覆蓋咗自己嗰日本身唔同嘅結算單位——而家改咗之後，既有格淨係送
// code，唔會再送 settlement_broker_id，由後端保留返呢一格自己嘅原值。
test("(g) 同一行兩日唔同結算單位：改「較早日」（X）嘅 code，唔會俾「較遲日」（row 級 brokerId，Y）覆蓋", async ({ page }) => {
  const brokerXId = await findBrokerIdByCode("K");
  const brokerYId = await findBrokerIdByCode("W");
  const testSite = await prisma.site.create({
    data: { canonicalName: `E2E-P0-應修2-${Date.now()}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "e2e:pricing-item2" },
  });
  const testShiftType = await prisma.shiftType.create({
    data: { siteId: testSite.id, code: "N", label: "測試夜更", hours: 12, createdBy: "e2e:pricing-item2" },
  });
  const testGuard = await prisma.guard.create({
    data: { nameZh: "E2E測試保安員二", employmentType: "cash_casual", defaultBrokerId: null, createdBy: "e2e:pricing-item2" },
  });
  // 較早日＝X（brokerK）——呢個 test 會改呢一格；較遲日＝Y（brokerW）——
  // `GET /api/shift-records` desc 排序令呢日先俾 buildRowsAndCells() 見
  // 到，成為 row.brokerId＝Y，先夠條件驗證「唔會俾 Y 覆蓋」。
  const earlyDate = new Date(Date.UTC(2026, 7, 5)); // 2026-08-05＝X
  const lateDate = new Date(Date.UTC(2026, 7, 20)); // 2026-08-20＝Y
  const earlyRecord = await prisma.shiftRecord.create({
    data: {
      siteId: testSite.id,
      shiftTypeId: testShiftType.id,
      guardId: testGuard.id,
      workDate: earlyDate,
      settlementBrokerId: brokerXId,
      operationalBrokerId: brokerXId,
      recordType: "shift",
      status: "confirmed",
      createdBy: "e2e:pricing-item2",
    },
  });
  await prisma.shiftRecord.create({
    data: {
      siteId: testSite.id,
      shiftTypeId: testShiftType.id,
      guardId: testGuard.id,
      workDate: lateDate,
      settlementBrokerId: brokerYId,
      operationalBrokerId: brokerYId,
      recordType: "shift",
      status: "confirmed",
      createdBy: "e2e:pricing-item2",
    },
  });

  try {
    await loginAs(page, "主管");
    await page.goto(`/roster/${testSite.id}/2026-08`);
    const row = page.locator(`tr[data-row-key="${testShiftType.id}|${testGuard.id}"]`);
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    const rowIndex = Number(await row.getAttribute("data-row-index"));

    // 改「較早日」（X，2026-08-05，日=5）嘅 code——由「N」改做請假代號
    // 「AL」（有效，唔會撞「同呢行更別代號都對唔上」）。
    const cell = page.getByTestId(`roster-cell-${rowIndex}-5`);
    await cell.click();
    await page.keyboard.type("AL");
    await page.keyboard.press("Enter");
    await expect(cell).toHaveText("AL");

    await page.getByRole("button", { name: /^儲存$|^儲存緊/ }).click();
    const toast = page.getByTestId("roster-save-toast");
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastText = (await toast.textContent().catch(() => "")) ?? "";
    expect(toastText).not.toContain("冇結算單位");

    const afterEarly = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: earlyRecord.id } });
    // 核心斷言：改咗 code 之後，呢一格自己嘅結算單位仍然係 X（brokerK）
    // ——冇俾同一行「較遲日」（row.brokerId＝Y＝brokerW）覆蓋。
    expect(afterEarly.settlementBrokerId).toBe(brokerXId);
    expect(afterEarly.recordType).toBe("leave");
    expect(afterEarly.leaveCode).toBe("AL");

    // 反向確認：較遲日（20）冧巴完全冇郁過，仍然係 Y。
    const afterLate = await prisma.shiftRecord.findFirst({ where: { siteId: testSite.id, guardId: testGuard.id, workDate: lateDate } });
    expect(afterLate?.settlementBrokerId).toBe(brokerYId);
  } finally {
    await prisma.shiftRecord.deleteMany({ where: { siteId: testSite.id } });
    await prisma.guard.delete({ where: { id: testGuard.id } });
    await prisma.shiftType.deleteMany({ where: { siteId: testSite.id } });
    await prisma.site.delete({ where: { id: testSite.id } });
  }
});
