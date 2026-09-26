// WP-LTSHIFT（老闆 2026-09-26 §3）：長工介紹費自動計——純函數
// `computeReferralFees()` 單元測試＋`recomputeReferralFees()` DB
// integration test（idempotent、7 月拒絕、唔踩人手輸入）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { computeReferralFees, computeReferralFeesForMonth, recomputeReferralFees, REFERRAL_FEE_EXEMPT_CLIENT_GROUP } from "@/lib/reports/referral-fee";

describe("computeReferralFees（純函數）", () => {
  it("逐 (guard,site) B07 更數 × 費率，逐雞頭合計", () => {
    const r = computeReferralFees({
      guards: [
        { guardId: "guard-1", referralBrokerId: "broker-k" },
        { guardId: "guard-2", referralBrokerId: "broker-k" },
      ],
      shiftCounts: [
        { guardId: "guard-1", siteId: "site-a", count: 20 },
        { guardId: "guard-2", siteId: "site-b", count: 10 },
      ],
      rates: [{ brokerId: "broker-k", siteId: null, feePerShift: 50 }],
      sites: [
        { siteId: "site-a", clientGroup: null },
        { siteId: "site-b", clientGroup: null },
      ],
    });
    expect(r.lineItems).toHaveLength(2);
    expect(r.totalsByBroker.get("broker-k")).toBe(1500); // 20*50 + 10*50
    expect(r.totalAmount).toBe(1500);
    expect(r.warnings).toHaveLength(0);
  });

  it("盤級費率覆蓋全盤預設", () => {
    const r = computeReferralFees({
      guards: [{ guardId: "guard-1", referralBrokerId: "broker-k" }],
      shiftCounts: [{ guardId: "guard-1", siteId: "site-a", count: 10 }],
      rates: [
        { brokerId: "broker-k", siteId: null, feePerShift: 50 },
        { brokerId: "broker-k", siteId: "site-a", feePerShift: 80 },
      ],
      sites: [{ siteId: "site-a", clientGroup: null }],
    });
    expect(r.lineItems[0].feePerShift).toBe(80);
    expect(r.totalAmount).toBe(800);
  });

  it("規則 12a：卓弘客戶盤豁免——唔計入 lineItems，計入 exemptShiftCount", () => {
    const r = computeReferralFees({
      guards: [{ guardId: "guard-1", referralBrokerId: "broker-k" }],
      shiftCounts: [{ guardId: "guard-1", siteId: "site-zhuohong", count: 15 }],
      rates: [{ brokerId: "broker-k", siteId: null, feePerShift: 50 }],
      sites: [{ siteId: "site-zhuohong", clientGroup: REFERRAL_FEE_EXEMPT_CLIENT_GROUP }],
    });
    expect(r.lineItems).toHaveLength(0);
    expect(r.exemptShiftCount).toBe(15);
    expect(r.totalAmount).toBe(0);
  });

  it("冇任何費率（盤級／預設都冇）——入 warnings，唔屈估金額", () => {
    const r = computeReferralFees({
      guards: [{ guardId: "guard-1", referralBrokerId: "broker-k" }],
      shiftCounts: [{ guardId: "guard-1", siteId: "site-a", count: 5 }],
      rates: [],
      sites: [{ siteId: "site-a", clientGroup: null }],
    });
    expect(r.lineItems).toHaveLength(0);
    expect(r.warnings).toEqual([{ guardId: "guard-1", brokerId: "broker-k", siteId: "site-a", shifts: 5, reason: expect.stringContaining("冇設介紹費率") }]);
  });

  it("冇 referral_broker 嘅安員——B07 更數唔計入任何雞頭（唔屈估邊個介紹）", () => {
    const r = computeReferralFees({
      guards: [],
      shiftCounts: [{ guardId: "guard-1", siteId: "site-a", count: 5 }],
      rates: [{ brokerId: "broker-k", siteId: null, feePerShift: 50 }],
      sites: [{ siteId: "site-a", clientGroup: null }],
    });
    expect(r.lineItems).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});

describe("recomputeReferralFees（DB integration）", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function makeBroker(code: string, kind: "broker" | "internal_longterm" = "broker") {
    return prisma.broker.create({ data: { code, name: `測試${code}`, kind, settlementType: kind === "internal_longterm" ? "salary" : "cash", createdBy: "test:referral-fee" } });
  }
  async function makeSite(name: string, clientGroup: string | null = null) {
    return prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", clientGroup, billingModel: "per_shift", createdBy: "test:referral-fee" } });
  }
  async function makeGuard(referralBrokerId: string | null) {
    return prisma.guard.create({ data: { nameZh: "測試長工", employmentType: "longterm_autopay", referralBrokerId, createdBy: "test:referral-fee" } });
  }
  async function makeShiftType(siteId: string) {
    return prisma.shiftType.create({ data: { siteId, code: "N", label: "測試更", hours: 12, createdBy: "test:referral-fee" } });
  }
  async function makeActorUserId(): Promise<string> {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試會計", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    return user.id;
  }

  it("拒絕 2026-07 或更早（7 月已人手入，唔可以自動覆蓋）", async () => {
    const actorUserId = await makeActorUserId();
    await expect(recomputeReferralFees(new Date("2026-07-01"), actorUserId, null)).rejects.toMatchObject({ status: 400 });
  });

  it("計出嚟嘅金額 upsert 做 special_items(kind=referral_fee)，再跑一次冪等（唔會重複疊加）", async () => {
    const k = await makeBroker("TEST-RK");
    const b07 = await makeBroker("TEST-B07", "internal_longterm");
    const site = await makeSite("測試長工盤");
    const guard = await makeGuard(k.id);
    const st = await makeShiftType(site.id);
    await prisma.referralFeeRate.create({ data: { brokerId: k.id, siteId: null, month: new Date("2026-08-01"), feePerShift: 100, createdBy: "test" } });
    for (let d = 1; d <= 3; d++) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(`2026-08-0${d}`), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: b07.id, operationalBrokerId: k.id } });
    }

    const actorUserId = await makeActorUserId();
    const r1 = await recomputeReferralFees(new Date("2026-08-01"), actorUserId, null);
    expect(r1.totalAmount).toBe(300); // 3 更 × $100
    expect(r1.createdCount).toBe(1);
    expect(r1.voidedCount).toBe(0);

    const items1 = await prisma.specialItem.findMany({ where: { month: new Date("2026-08-01"), kind: "referral_fee", voidedAt: null } });
    expect(items1).toHaveLength(1);
    expect(Number(items1[0].cost)).toBe(300);

    // 再跑一次：舊嗰行作廢、新建一行，總金額唔變（冪等，唔會疊加做 600）。
    const r2 = await recomputeReferralFees(new Date("2026-08-01"), actorUserId, null);
    expect(r2.totalAmount).toBe(300);
    expect(r2.voidedCount).toBe(1);
    expect(r2.createdCount).toBe(1);
    const items2 = await prisma.specialItem.findMany({ where: { month: new Date("2026-08-01"), kind: "referral_fee", voidedAt: null } });
    expect(items2).toHaveLength(1);
    expect(Number(items2[0].cost)).toBe(300);
  });

  it("WP-LTSHIFT §19：費率表冇呢個月嘅行就跌返用之前最近一個月（effective-dated，唔使逐月人手重覆制一份）", async () => {
    const k = await makeBroker("TEST-RK3");
    const b07 = await makeBroker("TEST-B073", "internal_longterm");
    const site = await makeSite("測試長工盤3");
    const guard = await makeGuard(k.id);
    const st = await makeShiftType(site.id);
    // 淨係喺 7 月設咗費率，9 月冇再入一次。
    await prisma.referralFeeRate.create({ data: { brokerId: k.id, siteId: null, month: new Date("2026-07-01"), feePerShift: 40, createdBy: "test" } });
    for (let d = 1; d <= 2; d++) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(`2026-09-0${d}`), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: b07.id, operationalBrokerId: k.id } });
    }
    const r = await computeReferralFeesForMonth(new Date("2026-09-01"));
    expect(r.warnings).toHaveLength(0); // 冇 warning＝搵到費率（跌返用 7 月嗰個），唔係屈估
    expect(r.totalAmount).toBe(80); // 2 更 × $40（7 月費率）
  });

  it("唔會踩到人手輸入嘅 referral_fee special_item（createdBy 唔係 recompute 前綴）", async () => {
    const k = await makeBroker("TEST-RK2");
    const site = await makeSite("測試盤2");
    await prisma.specialItem.create({ data: { month: new Date("2026-08-01"), siteId: site.id, brokerId: k.id, kind: "referral_fee", cost: 999, createdBy: "manual:accountant" } });

    const actorUserId = await makeActorUserId();
    await recomputeReferralFees(new Date("2026-08-01"), actorUserId, null);

    const manual = await prisma.specialItem.findFirst({ where: { createdBy: "manual:accountant", voidedAt: null } });
    expect(manual).not.toBeNull();
    expect(Number(manual!.cost)).toBe(999);
  });

  it("computeReferralFeesForMonth：DB loader 對接純函數（冇任何長工介紹記錄就全部空）", async () => {
    const r = await computeReferralFeesForMonth(new Date("2026-08-01"));
    expect(r.lineItems).toHaveLength(0);
    expect(r.totalAmount).toBe(0);
  });
});
