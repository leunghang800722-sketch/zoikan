// WP-MIXED-BILLING（老闆 2026-09-24 拍板方案 (a)）：月費盤可以同時有逐更
// 收客卡——盤嘅收入 = flat 卡（或 pro-rata fallback）+ 該盤
// billing_group='per_shift' 更種嘅逐更 client_rate_snapshot 合計；
// billing_group='monthly_ic' 嘅更種唔另外收客（已經包喺月費）。
//
// 例子（控制室 8 月）：月薪崗更種 billing_group=monthly_ic（25 更，冇逐更
// client_rate）+ 日薪崗更種 billing_group=per_shift（22 更 × 840 = 18,480）
// + site flat 卡 22,000 → 收入 40,480。
//
// 規則只對 2026-08-01 起嘅月份生效（見 src/lib/reports/monthly-close.ts
// 「WP-MIXED-BILLING」段落）——7 月鐵則唔准變 gate 數字，7 月保留舊口徑
// （有 flat 卡就淨係計 flat，唔加逐更）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";

const JULY = new Date(Date.UTC(2026, 6, 1));
const AUG = new Date(Date.UTC(2026, 7, 1));

async function makeGuard(nameZh: string) {
  return prisma.guard.create({ data: { nameZh, employmentType: "cash_casual", createdBy: "test" } });
}

describe("WP-MIXED-BILLING：monthly_fixed 盤同時有 flat 卡 + per_shift 更種逐更卡", () => {
  let siteId: string;
  let monthlyIcShiftTypeId: string;
  let perShiftShiftTypeId: string;

  beforeAll(async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: {
        canonicalName: "測試盤-控制室混合billing",
        clientName: "測試客戶",
        billingModel: "monthly_fixed",
        monthlyFee: null, // 靠 rate_card flat 卡，唔靠 monthly_fee×posts pro-rata
        inScope: true,
        status: "active",
        createdBy: "test",
      },
    });
    siteId = site.id;

    const monthlyIcType = await prisma.shiftType.create({
      data: { siteId, code: "N-IC", billingGroup: "monthly_ic", startTime: new Date("1970-01-01T19:30:00Z"), endTime: new Date("1970-01-01T07:30:00Z"), createdBy: "test" },
    });
    monthlyIcShiftTypeId = monthlyIcType.id;
    const perShiftType = await prisma.shiftType.create({
      data: { siteId, code: "N", billingGroup: "per_shift", startTime: new Date("1970-01-01T19:30:00Z"), endTime: new Date("1970-01-01T07:30:00Z"), createdBy: "test" },
    });
    perShiftShiftTypeId = perShiftType.id;

    // site flat 卡（月薪崗，唔理任何更種）—— 8 月＋7 月兩個月都生效
    // （effective_from 早過兩個月，effective_to=null，模擬「無限期卡」）。
    await prisma.rateCard.create({
      data: { siteId, billingModel: "monthly_fixed", clientRate: 22000, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: null, createdBy: "test" },
    });

    // 日薪崗更種嘅 8 月逐更收客卡（effective_from=2026-08-01）——Opus 5.5
    // 驗收：淨係有呢類卡嘅 per_shift 更種先算「逐更另收」（見
    // src/lib/reports/mixed-billing.ts）。
    await prisma.rateCard.create({
      data: { siteId, shiftTypeId: perShiftShiftTypeId, billingModel: "per_shift", clientRate: 840, guardWage: 800, brokerFee: 0, effectiveFrom: AUG, effectiveTo: null, createdBy: "test" },
    });

    const guardIc = await makeGuard("測試-月薪崗");
    const guardPerShift = await makeGuard("測試-日薪崗");

    // 25 更 monthly_ic（月薪崗，冇逐更 client_rate_snapshot——收入已經喺 flat 卡）
    for (let d = 1; d <= 25; d++) {
      await prisma.shiftRecord.create({
        data: {
          siteId,
          shiftTypeId: monthlyIcShiftTypeId,
          guardId: guardIc.id,
          workDate: new Date(Date.UTC(2026, 7, d)),
          recordType: "shift",
          status: "confirmed",
          clientRateSnapshot: null,
          guardWageSnapshot: 800,
          createdBy: "test",
        },
      });
    }
    // 22 更 per_shift（日薪崗，840/更）
    for (let d = 1; d <= 22; d++) {
      await prisma.shiftRecord.create({
        data: {
          siteId,
          shiftTypeId: perShiftShiftTypeId,
          guardId: guardPerShift.id,
          workDate: new Date(Date.UTC(2026, 7, d)),
          recordType: "shift",
          status: "confirmed",
          clientRateSnapshot: 840,
          guardWageSnapshot: 800,
          createdBy: "test",
        },
      });
    }
  });

  it("8 月（mixed billing 生效）：收入 = flat 22,000 + per_shift 22×840=18,480 = 40,480", async () => {
    const { mainRows } = await buildMonthlyClose(AUG);
    const row = mainRows.find((r) => r.siteId === siteId);
    expect(row, "混合 billing 嘅盤應該喺 mainRows 出現").toBeDefined();
    expect(row!.revenue).toBe(40480);
    expect(row!.shifts).toBe(22); // shiftAgg 淨係計 billing_group=per_shift 嘅更（monthly_ic 唔計入更數，同 CP5 IC 既有口徑一致）
  });

  it("gross-margin：site revenue 一樣係 40,480（直接沿用 buildMonthlyClose 嘅口徑）", async () => {
    const result = await buildGrossMargin(AUG);
    const siteRow = result.sites.find((s) => s.siteId === siteId);
    expect(siteRow, "混合 billing 嘅盤應該喺毛利表出現").toBeDefined();
    expect(siteRow!.revenue).toBe(40480);
    expect(siteRow!.components.revenue.base).toBe(40480);
  });

  it("7 月（mixed billing 未生效，鐵則保留舊口徑）：淨係計 flat 卡 22,000，唔加逐更", async () => {
    // 用返同一個 site/shift_type，複製一份 7 月記錄（同一份業務資料，唔同月份）。
    const guardIc = await makeGuard("測試-7月-月薪崗");
    const guardPerShift = await makeGuard("測試-7月-日薪崗");
    for (let d = 1; d <= 25; d++) {
      await prisma.shiftRecord.create({
        data: { siteId, shiftTypeId: monthlyIcShiftTypeId, guardId: guardIc.id, workDate: new Date(Date.UTC(2026, 6, d)), recordType: "shift", status: "confirmed", clientRateSnapshot: null, guardWageSnapshot: 800, createdBy: "test" },
      });
    }
    for (let d = 1; d <= 22; d++) {
      await prisma.shiftRecord.create({
        data: { siteId, shiftTypeId: perShiftShiftTypeId, guardId: guardPerShift.id, workDate: new Date(Date.UTC(2026, 6, d)), recordType: "shift", status: "confirmed", clientRateSnapshot: 840, guardWageSnapshot: 800, createdBy: "test" },
      });
    }
    const { mainRows } = await buildMonthlyClose(JULY);
    const row = mainRows.find((r) => r.siteId === siteId);
    expect(row).toBeDefined();
    expect(row!.revenue).toBe(22000); // 舊口徑：有 flat 卡就淨係計 flat，唔加 18,480
  });
});

describe("WP-MIXED-BILLING：對照組——純 monthly_ic 盤／純 per_shift 盤收入唔變", () => {
  afterEach(async () => {
    await clearAll();
  });

  it("純 monthly 盤（成個盤淨係 monthly_ic 更種）：8 月收入照舊淨係 flat 卡金額", async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: { canonicalName: "測試盤-純月費", clientName: "測試客戶", billingModel: "monthly_fixed", inScope: true, status: "active", createdBy: "test" },
    });
    const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "IC", billingGroup: "monthly_ic", createdBy: "test" } });
    await prisma.rateCard.create({
      data: { siteId: site.id, billingModel: "monthly_fixed", clientRate: 18580.65, effectiveFrom: new Date(Date.UTC(2026, 7, 1)), effectiveTo: null, createdBy: "test" },
    });
    const guard = await makeGuard("測試-純月費崗");
    for (let d = 1; d <= 25; d++) {
      await prisma.shiftRecord.create({
        data: { siteId: site.id, shiftTypeId: shiftType.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 7, d)), recordType: "shift", status: "confirmed", clientRateSnapshot: null, createdBy: "test" },
      });
    }
    const { mainRows } = await buildMonthlyClose(AUG);
    const row = mainRows.find((r) => r.siteId === site.id);
    expect(row).toBeDefined();
    expect(row!.revenue).toBe(18580.65);
  });

  it("純 per_shift 盤（冇 flat 卡）：8 月收入照舊淨係逐更 client_rate_snapshot 加總", async () => {
    await clearAll();
    const site = await prisma.site.create({
      data: { canonicalName: "測試盤-純逐更", clientName: "測試客戶", billingModel: "per_shift", inScope: true, status: "active", createdBy: "test" },
    });
    const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", billingGroup: "per_shift", createdBy: "test" } });
    const guard = await makeGuard("測試-純逐更崗");
    for (let d = 1; d <= 10; d++) {
      await prisma.shiftRecord.create({
        data: { siteId: site.id, shiftTypeId: shiftType.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 7, d)), recordType: "shift", status: "confirmed", clientRateSnapshot: 500, createdBy: "test" },
      });
    }
    const { mainRows } = await buildMonthlyClose(AUG);
    const row = mainRows.find((r) => r.siteId === site.id);
    expect(row).toBeDefined();
    expect(row!.revenue).toBe(5000);
  });
});

// Opus 5.5 驗收（雙重計算風險）：月費盤（7 月 flat 卡無限期覆蓋 8 月）上面
// 嘅 per_shift 更種，如果冇 effective_from>=2026-08-01 嘅逐更收客卡，就算
// 記錄帶住 client snapshot（例：IFC 8 月試算 E=853.66＝35,000÷41 嘅倒算
// 值、7 月匯入嘅派生卡），都當「已包喺月費」——唔加收入、唔標未定價。
describe("WP-MIXED-BILLING（Opus 5.5 驗收）：月費盤唔會 flat＋倒算逐更雙重計", () => {
  afterEach(async () => {
    await clearAll();
  });

  async function setupIfcLike(opts: { julyDerivedCard: boolean }) {
    await clearAll();
    const site = await prisma.site.create({
      data: { canonicalName: "測試盤-IFC型", clientName: "測試客戶", billingModel: "monthly_fixed", monthlyFee: 35000, inScope: true, status: "active", createdBy: "test" },
    });
    const d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", billingGroup: "per_shift", createdBy: "test" } });
    // 7 月 flat 卡，無限期（WP-PRICE migration 伸長）
    await prisma.rateCard.create({ data: { siteId: site.id, billingModel: "monthly_fixed", clientRate: 35000, effectiveFrom: JULY, effectiveTo: null, createdBy: "test" } });
    if (opts.julyDerivedCard) {
      // 7 月匯入嘅派生逐更卡（client＝月費÷更數），無限期
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, billingModel: "per_shift", clientRate: 853.66, guardWage: 800, effectiveFrom: JULY, effectiveTo: null, createdBy: "test" } });
    }
    const guardA = await makeGuard("測試-IFC型-甲");
    const guardB = await makeGuard("測試-IFC型-乙");
    for (let day = 1; day <= 41; day++) {
      await prisma.shiftRecord.create({
        data: { siteId: site.id, shiftTypeId: d.id, guardId: day <= 31 ? guardA.id : guardB.id, workDate: new Date(Date.UTC(2026, 7, ((day - 1) % 31) + 1)), recordType: "shift", status: "confirmed", clientRateSnapshot: 853.66, guardWageSnapshot: 800, createdBy: "test" },
      });
    }
    return site.id;
  }

  it("冇 8 月逐更收客卡（snapshot 仍然帶 853.66）：8 月收入＝flat 35,000，唔係 70,000", async () => {
    const siteId = await setupIfcLike({ julyDerivedCard: false });
    const { mainRows } = await buildMonthlyClose(AUG);
    expect(mainRows.find((r) => r.siteId === siteId)!.revenue).toBe(35000);
    const gm = await buildGrossMargin(AUG);
    const row = gm.sites.find((s) => s.siteId === siteId)!;
    expect(row.revenue).toBe(35000);
    // 展開更別：per_shift 行收入顯示 0（包喺月費），加埋等於盤總數
    const dRow = row.shiftTypes.find((s) => s.code === "D")!;
    expect(dRow.revenue).toBe(0);
    expect(dRow.note).toBe("收入已包喺月費");
  });

  it("7 月派生逐更卡（effective_from=2026-07-01）唔可以觸發逐更另收：8 月收入仍然係 35,000", async () => {
    const siteId = await setupIfcLike({ julyDerivedCard: true });
    const { mainRows } = await buildMonthlyClose(AUG);
    expect(mainRows.find((r) => r.siteId === siteId)!.revenue).toBe(35000);
  });
});
