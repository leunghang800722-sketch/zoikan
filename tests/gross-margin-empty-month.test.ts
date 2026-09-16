// WP-AI3 第二輪 live 驗收 bug fix：月費盤（billing_model=monthly_fixed,
// monthly_fee 有值）嘅 pro-rata fallback（`monthlyFeeProrataRevenue()`/
// gross-margin.ts 嘅重複實現）之前齋憑 site 設定就計出一舊金額，完全
// 冇檢查呢個盤呢個月係咪真係有活動——對完全冇 shift_records/daily_
// requirements 嘅月份（例如業務未開始嘅 2025-07），會計出假營業額、
// 成本 0、毛利率 100%。
//
// 呢度驗證：(1) 完全冇活動嘅月份 → gross_margin totals revenue=0、
// cost=0（唔會 100%毛利率）；個別 site row（依家會強制包埋月費盤）
// revenue=0，note 講明「該月冇更次記錄」；(2) 同一個盤，如果嗰個月
// 真係有 daily_requirement（證明有活動），fallback 要照常計出金額
// （證明冇整壞正常情況）；(3) monthly_close.ts 嘅同一個 bug 都一齊修
// 咗——完全冇活動嗰個月唔會顯示呢個盤（同「完全冇活動嘅盤唔顯示」嘅
// 既有慣例一致，唔會漏咗假數）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";

const EMPTY_MONTH = new Date(Date.UTC(2025, 6, 1)); // 2025-07——業務未開始，全公司呢個月冇任何 shift_records
const ACTIVE_MONTH = new Date(Date.UTC(2025, 7, 1)); // 2025-08——用嚟測「有活動就照常計」嘅對照組

describe("WP-AI3：毛利即時表／月結總表——空月份唔准出現假月費收入", () => {
  let siteId: string;
  let shiftTypeId: string;

  beforeAll(async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: {
        canonicalName: "測試月費盤-空月份bug",
        clientName: "測試客戶",
        billingModel: "monthly_fixed",
        monthlyFee: 50000,
        monthlyPosts: 3, // 冇呢個 gate 之前：50000×3×31/31 = 150000 假營業額，成本 0 = 100% 毛利率
        inScope: true,
        status: "active",
        createdBy: "test",
      },
    });
    siteId = site.id;
    const shiftType = await prisma.shiftType.create({
      data: { siteId, code: "N", billingGroup: "per_shift", createdBy: "test" },
    });
    shiftTypeId = shiftType.id;
  });

  afterEach(async () => {
    // 淨係清返 ACTIVE_MONTH 個 daily_requirement，等每條 test 之間唔會
    // 互相污染（site/shiftType 本身跨 test 共用，唔喺呢度清）。
    await prisma.dailyRequirement.deleteMany({ where: { siteId } });
  });

  it("完全冇活動嘅月份（2025-07）：gross_margin totals revenue=0、cost=0，唔會出現假 100% 毛利率", async () => {
    const result = await buildGrossMargin(EMPTY_MONTH);
    expect(result.totals.revenue).toBe(0);
    expect(result.totals.cost).toBe(0);
    expect(result.totals.marginPct).toBeNull();

    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow, "月費盤就算冇活動都應該喺報表度出現（等用戶知道『查過確認冇活動』）").toBeDefined();
    expect(siteRow!.revenue).toBe(0);
    expect(siteRow!.cost).toBe(0);
    expect(siteRow!.marginPct).toBeNull();
    expect(siteRow!.isMonthlyFee).toBe(false); // fallback 冇套用，唔會有「月費」展示行
    expect(siteRow!.note).toContain("該月冇更次記錄");
  });

  it("同一個盤，如果嗰個月真係有 daily_requirement（有活動）：fallback 照常計出月費金額（冇整壞正常情況）", async () => {
    await prisma.dailyRequirement.create({
      data: { siteId, shiftTypeId, workDate: new Date(Date.UTC(2025, 7, 5)), headcountRequired: 1, createdBy: "test" },
    });
    const result = await buildGrossMargin(ACTIVE_MONTH);
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow).toBeDefined();
    expect(siteRow!.isMonthlyFee).toBe(true);
    expect(siteRow!.revenue).toBeGreaterThan(0); // 50000×3 嘅 pro-rata，具體數值唔係重點，重點係唔再係 0
    expect(siteRow!.note).not.toContain("該月冇更次記錄");
  });

  it("monthly_close.ts 同一個 bug 都一齊修咗：完全冇活動嘅月份，呢個盤唔會顯示喺 mainRows/outsideRows（同『完全冇活動嘅盤唔顯示』既有慣例一致，唔會漏咗假數）", async () => {
    const { mainRows, outsideRows } = await buildMonthlyClose(EMPTY_MONTH);
    expect(mainRows.some((r) => r.siteId === siteId)).toBe(false);
    expect(outsideRows.some((r) => r.siteId === siteId)).toBe(false);
  });

  it("monthly_close.ts：同一個盤，有 daily_requirement 嘅月份照常計出金額（冇整壞正常情況）", async () => {
    await prisma.dailyRequirement.create({
      data: { siteId, shiftTypeId, workDate: new Date(Date.UTC(2025, 7, 5)), headcountRequired: 1, createdBy: "test" },
    });
    const { mainRows } = await buildMonthlyClose(ACTIVE_MONTH);
    const row = mainRows.find((r) => r.siteId === siteId);
    expect(row).toBeDefined();
    expect(row!.revenue).toBeGreaterThan(0);
  });
});

// WP-PRICE（老闆 2026-09-16 拍板）：8 月價目卡伸長做無限期之後
// （prisma/migrations/20260916000000_extend_rate_cards_open_ended），
// `flatCard`（monthly_fixed 盤嘅 site 级 rate_card）對任何未來月份都會
// 直接命中（唔再淨係 7 月）——之前上面嗰個「空月份 gate」淨係喺
// *冇*直接命中卡嗰陣先行到嘅 fallback 公式度把關，一張已經伸長做無限期
// 嘅卡會直接繞過成個 gate（bug：見 src/lib/reports/gross-margin.ts／
// monthly-close.ts「WP-PRICE bug fix」段落）。呢度專登起一張 effective_
// to=null 嘅月費卡，斷言一個真係零更次嘅未來月份（2026-09）毛利表/
// 月結總表仍然係 0 營業額，唔會因為張卡直接命中就顯示假錢。
describe("WP-PRICE：rate_cards 伸長做無限期之後，零更次月份唔可以因為張卡直接命中就顯示假營業額", () => {
  const ZERO_ACTIVITY_MONTH = new Date(Date.UTC(2026, 8, 1)); // 2026-09——冇任何 shift_records/daily_requirements
  let siteId: string;

  beforeAll(async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: {
        canonicalName: "測試月費盤-卡無限期bug",
        clientName: "測試客戶",
        billingModel: "monthly_fixed",
        monthlyFee: 30000,
        monthlyPosts: 2,
        inScope: true,
        status: "active",
        createdBy: "test",
      },
    });
    siteId = site.id;
    // 模擬 migration 之後嘅狀態：site 级 flat 卡（shiftType/broker/guard 皆
    // 空），effective_to=null（無限期），effective_from 喺 2026-09 之前。
    await prisma.rateCard.create({
      data: {
        siteId,
        billingModel: "monthly_fixed",
        clientRate: 30000,
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
        effectiveTo: null,
        createdBy: "test",
      },
    });
  });

  it("gross-margin：2026-09 零更次，revenue=0，note 講明冇更次記錄（唔係因為卡直接命中就顯示 $30000）", async () => {
    const result = await buildGrossMargin(ZERO_ACTIVITY_MONTH);
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow, "月費盤就算冇活動都應該喺報表度出現").toBeDefined();
    expect(siteRow!.revenue).toBe(0);
    expect(siteRow!.isMonthlyFee).toBe(false);
    expect(siteRow!.note).toContain("該月冇更次記錄");
  });

  it("monthly-close：2026-09 零更次，呢個盤唔會顯示喺 mainRows/outsideRows", async () => {
    const { mainRows, outsideRows } = await buildMonthlyClose(ZERO_ACTIVITY_MONTH);
    expect(mainRows.some((r) => r.siteId === siteId)).toBe(false);
    expect(outsideRows.some((r) => r.siteId === siteId)).toBe(false);
  });

  it("對照組：呢張無限期卡喺真係有活動嘅月份（2026-08）照常計出 $30000（冇整壞正常情況）", async () => {
    const shiftType = await prisma.shiftType.create({ data: { siteId, code: "N2", billingGroup: "per_shift", createdBy: "test" } });
    await prisma.dailyRequirement.create({
      data: { siteId, shiftTypeId: shiftType.id, workDate: new Date(Date.UTC(2026, 7, 5)), headcountRequired: 1, createdBy: "test" },
    });
    const result = await buildGrossMargin(new Date(Date.UTC(2026, 7, 1)));
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow!.isMonthlyFee).toBe(true);
    expect(siteRow!.revenue).toBe(30000);
  });
});

// M2（Opus 驗收，2026-09-16）：之前「零活動月份唔准假營業額」呢條閘
// 淨係喺 site.billing_model==="monthly_fixed" 先查——special／admin_fee
// 嘅盤級 flat 卡、更別級 special 卡（例如啟航1331 Event Guard $11,700）
// 完全冇被呢條閘擋住，零活動月份一樣會計出假營業額。呢度覆蓋 Opus 驗收
// 明文提到嘅 case：更別級 special 卡（billing_model=special、shift_type_id
// 有值、broker/guard 皆空）喺零活動月份，revenue 一定要係 0，唔可以列
// 出 11700。
describe("M2：更別級／site 級 special、admin_fee 卡——零活動月份都唔准假營業額", () => {
  const ZERO_ACTIVITY_MONTH = new Date(Date.UTC(2026, 8, 1)); // 2026-09
  const ACTIVE_MONTH2 = new Date(Date.UTC(2026, 7, 1)); // 2026-08
  let siteId: string;
  let shiftTypeId: string;

  beforeAll(async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: {
        canonicalName: "測試盤-Event Guard special卡",
        clientName: "測試客戶",
        billingModel: "per_shift",
        inScope: true,
        status: "active",
        createdBy: "test",
      },
    });
    siteId = site.id;
    const shiftType = await prisma.shiftType.create({
      data: { siteId, code: "EVT", billingGroup: "per_shift", createdBy: "test" },
    });
    shiftTypeId = shiftType.id;
    // 更別級 special 卡——唔按更數拆，$11,700 一筆過（同啟航1331 Event
    // Guard 一致嘅形狀：shift_type_id 有值、broker/guard 皆空、effective_
    // to=null 無限期）。
    await prisma.rateCard.create({
      data: {
        siteId,
        shiftTypeId,
        billingModel: "special",
        clientRate: 11700,
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
        effectiveTo: null,
        createdBy: "test",
      },
    });
  });

  it("gross-margin：零活動月份（2026-09）revenue=0，唔會列出 $11,700 假營業額", async () => {
    const result = await buildGrossMargin(ZERO_ACTIVITY_MONTH);
    expect(result.totals.revenue).toBe(0);
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    if (siteRow) {
      // 零活動 site 依家可能因為 A2「全部有 shift_records 嘅盤」擴大條件
      // 唔出現（呢個 site 本身冇 mainRows 基準），出現嘅話 revenue 一定要 0。
      expect(siteRow.revenue).toBe(0);
    }
  });

  it("monthly-close：零活動月份（2026-09）呢個盤唔會顯示喺 mainRows/outsideRows（唔會夾埋 $11,700）", async () => {
    const { mainRows, outsideRows } = await buildMonthlyClose(ZERO_ACTIVITY_MONTH);
    expect(mainRows.some((r) => r.siteId === siteId)).toBe(false);
    expect(outsideRows.some((r) => r.siteId === siteId)).toBe(false);
  });

  it("對照組：有活動嘅月份（2026-08）照常計入 $11,700（冇整壞正常情況）", async () => {
    await prisma.shiftRecord.create({
      data: {
        siteId,
        shiftTypeId,
        guardId: (
          await prisma.guard.create({ data: { nameZh: "測試安員", employmentType: "cash_casual", createdBy: "test" } })
        ).id,
        workDate: new Date(Date.UTC(2026, 7, 3)),
        recordType: "shift",
        status: "confirmed",
        createdBy: "test",
      },
    });
    const { mainRows } = await buildMonthlyClose(ACTIVE_MONTH2);
    const row = mainRows.find((r) => r.siteId === siteId);
    expect(row, "有活動就應該喺 mainRows 出現").toBeDefined();
    expect(row!.revenue).toBe(11700);
  });
});
