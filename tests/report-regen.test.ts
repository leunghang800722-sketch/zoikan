import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedFakeFixture } from "./fixtures/fake-data";
import { buildMonthlyClose } from "../scripts/report/monthly-close";

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("報表重出邏輯（scripts/report/monthly-close.ts）", () => {
  it("per_shift 盤：更數/營業額/成本/盈利 由 shift_records snapshot Σ返嚟", async () => {
    await seedFakeFixture();
    const { mainRows } = await buildMonthlyClose();
    const row = mainRows.find((r) => r.canonicalName === "測試盤一號");
    expect(row).toBeDefined();
    expect(row!.shifts).toBe(2);
    expect(row!.revenue).toBe(1800); // 900+900
    expect(row!.cost).toBe(1550); // (700+50) + (800+0)
    expect(row!.profit).toBe(250);
  });

  it("monthly_fixed 盤：冇 flat rate_card 就用 sites.monthly_fee×monthly_posts×prorata 公式 fallback（規劃裁定 2026-09-12）", async () => {
    await seedFakeFixture();
    // 「測試月費盤」fixture 本身已經有 monthly_fee=10000（冇 monthly_posts/
    // prorata_basis，fallback 預設 posts=1、basis=div_31、分子=分母即足月）
    // ——冇任何 rate_cards 卡、冇 shift_records 都應該顯示呢個 site，用
    // 公式算出嚟嘅 10000（同 P0 舊行為唔一樣：舊行為「冇卡就唔顯示」喺
    // 8 月呢類冇歷史卡嘅月份會令月費盤完全消失，規劃裁定要求改用公式）。
    const { mainRows } = await buildMonthlyClose();
    const row = mainRows.find((r) => r.canonicalName === "測試月費盤");
    expect(row).toBeDefined();
    expect(row!.revenue).toBe(10000);
    expect(row!.shifts).toBe(0);

    // 加一張覆蓋 `month` 嘅 flat 卡之後，卡嘅金額優先於公式（歷史已驗證
    // 金額 > 公式估算）。
    const site = await prisma.site.findFirstOrThrow({ where: { canonicalName: "測試月費盤" } });
    await prisma.rateCard.create({
      data: {
        siteId: site.id,
        clientRate: 12345,
        billingModel: "monthly_fixed",
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
        effectiveTo: new Date(Date.UTC(2026, 6, 31)),
      },
    });
    const { mainRows: mainRows2 } = await buildMonthlyClose();
    const row2 = mainRows2.find((r) => r.canonicalName === "測試月費盤");
    expect(row2!.revenue).toBe(12345);
    expect(row2!.shifts).toBe(0);

    // 張卡嘅生效區間唔覆蓋 `month`（例如淨係 6 月）就唔應該被揀中，跌返
    // 用公式（bug fix：之前呢條 query 冇篩 effective_from/to，會撈到
    // 唔相干月份嘅舊卡）。
    await prisma.rateCard.updateMany({
      where: { siteId: site.id },
      data: { effectiveFrom: new Date(Date.UTC(2026, 5, 1)), effectiveTo: new Date(Date.UTC(2026, 5, 30)) },
    });
    const { mainRows: mainRows3 } = await buildMonthlyClose();
    const row3 = mainRows3.find((r) => r.canonicalName === "測試月費盤");
    expect(row3!.revenue).toBe(10000); // 跌返用公式，唔係嗰張 6 月卡嘅 12345
  });

  it("monthly_fixed 盤：冇 monthly_fee 就真係算 0 活動（同 shift_records 都冇）", async () => {
    await seedFakeFixture();
    const site = await prisma.site.findFirstOrThrow({ where: { canonicalName: "測試月費盤" } });
    await prisma.site.update({ where: { id: site.id }, data: { monthlyFee: null } });
    const { mainRows } = await buildMonthlyClose();
    const row = mainRows.find((r) => r.canonicalName === "測試月費盤");
    expect(row).toBeUndefined();
  });

  it("長工月薪分攤（P1-WP1 額外欄）：完整成本 = 成本 + 長工月薪分攤", async () => {
    await seedFakeFixture();
    const { mainRows } = await buildMonthlyClose();
    const row = mainRows.find((r) => r.canonicalName === "測試盤一號")!;
    expect(row.longtermSalaryAllocated).toBe(18000); // 長工個更喺呢個盤，全份月薪分咗嚟
    expect(row.fullCost).toBe(row.cost + 18000);
  });
});
