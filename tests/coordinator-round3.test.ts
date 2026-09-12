// 規劃 session 第三輪裁定（2026-09-11）嘅測試覆蓋：
// item 1(b) q10_double_pay query、item 3 cross_month_adjustment special_item。
// 全部假數據 fixture，唔碰真實 7 月數據（PDPO）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildQ10DoublePay, checkQ10Golden, type Q10Result } from "../scripts/report/q10";

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("item 1(b)：q10_double_pay（長工 employment_type=longterm_autopay 但 settlement_broker 屬現金雞頭桶）", () => {
  it("正確揀返 kind=broker/internal_cash 嘅桶，唔計 internal_longterm 自己嗰桶", async () => {
    const cashBroker = await prisma.broker.create({ data: { code: "T-Q10-CASH", name: "測試現金雞頭", kind: "broker", settlementType: "cash" } });
    const internalCashBroker = await prisma.broker.create({ data: { code: "T-Q10-Y", name: "測試公司兵桶", kind: "internal_cash", settlementType: "cash" } });
    const autopayBroker = await prisma.broker.create({ data: { code: "T-Q10-LT", name: "測試autopay桶", kind: "internal_longterm", settlementType: "autopay" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試Q10盤", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N" } });

    const longtermGuard = await prisma.guard.create({
      data: { nameZh: "測試Q10長工", employmentType: "longterm_autopay", monthlySalary: 23000 },
    });
    const casualGuard = await prisma.guard.create({ data: { nameZh: "測試Q10散工", employmentType: "cash_casual" } });

    // 長工 + settlement=現金雞頭（broker kind）→ 應該計入 Q10
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 1)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: longtermGuard.id,
        recordType: "shift",
        settlementBrokerId: cashBroker.id,
        operationalBrokerId: cashBroker.id,
        guardWageSnapshot: 850,
        brokerFeeSnapshot: 0,
      },
    });
    // 長工 + settlement=公司兵桶（internal_cash）→ 應該計入 Q10
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 2)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: longtermGuard.id,
        recordType: "shift",
        settlementBrokerId: internalCashBroker.id,
        operationalBrokerId: internalCashBroker.id,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
      },
    });
    // 長工 + settlement=autopay 自己桶（internal_longterm）→ 唔應該計入 Q10（單一支付，唔係雙重）
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 3)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: longtermGuard.id,
        recordType: "shift",
        settlementBrokerId: autopayBroker.id,
        operationalBrokerId: autopayBroker.id,
        guardWageSnapshot: 900,
        brokerFeeSnapshot: 0,
      },
    });
    // 散工（唔係長工）+ settlement=現金雞頭 → 正常單一支付，唔計 Q10
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 4)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: casualGuard.id,
        recordType: "shift",
        settlementBrokerId: cashBroker.id,
        operationalBrokerId: cashBroker.id,
        guardWageSnapshot: 800,
        brokerFeeSnapshot: 0,
      },
    });

    const result = await buildQ10DoublePay();
    expect(result.total).toBe(850 + 750); // 850 (broker) + 700+50 (internal_cash)，唔計 autopay 桶同散工
    expect(result.buckets).toHaveLength(2);
    const codes = result.buckets.map((b) => b.brokerCode).sort();
    expect(codes).toEqual(["T-Q10-CASH", "T-Q10-Y"].sort());
  });

  it("冇符合條件嘅記錄就回傳空桶、total=0", async () => {
    const result = await buildQ10DoublePay();
    expect(result.buckets).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("item 3：special_items kind=cross_month_adjustment", () => {
  it("可以掛喺 broker 層面（唔一定要有 site），cost 可以係負數", async () => {
    const broker = await prisma.broker.create({ data: { code: "T-XM", name: "測試跨月雞頭", kind: "broker", settlementType: "cash" } });
    const item = await prisma.specialItem.create({
      data: {
        month: new Date(Date.UTC(2026, 6, 1)),
        brokerId: broker.id,
        kind: "cross_month_adjustment",
        cost: -800,
        description: "測試跨月調整扣款",
      },
    });
    expect(item.siteId).toBeNull();
    expect(item.brokerId).toBe(broker.id);
    expect(Number(item.cost)).toBe(-800);
  });
});

describe("item 4(a)：checkQ10Golden 純函數邏輯（唔碰真實 DB，鎖住比對演算法本身）", () => {
  const GOLDEN: Q10Result = {
    total: 120682.94,
    buckets: [],
    guards: [
      { brokerCode: "Y", shifts: 49, amount: 23387.04 },
      { brokerCode: "K", shifts: 26, amount: 22100 },
      { brokerCode: "Y", shifts: 26, amount: 21849.88 },
      { brokerCode: "Y", shifts: 26, amount: 19000.02 },
      { brokerCode: "Y", shifts: 26, amount: 18668.52 },
      { brokerCode: "Y", shifts: 26, amount: 15677.48 },
    ],
  };

  it("完全符合 golden value 就 ok=true", () => {
    const { ok, problems } = checkQ10Golden(GOLDEN);
    expect(ok).toBe(true);
    expect(problems).toHaveLength(0);
  });

  it("少一個人就 ok=false", () => {
    const missing: Q10Result = { ...GOLDEN, guards: GOLDEN.guards.slice(1) };
    const { ok, problems } = checkQ10Golden(missing);
    expect(ok).toBe(false);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("金額差咗就 ok=false", () => {
    const wrong: Q10Result = { ...GOLDEN, total: GOLDEN.total + 1 };
    const { ok } = checkQ10Golden(wrong);
    expect(ok).toBe(false);
  });
});
