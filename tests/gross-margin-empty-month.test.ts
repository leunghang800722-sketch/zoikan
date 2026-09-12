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
