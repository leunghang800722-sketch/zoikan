// P0（Opus 驗收重現）：`resolveSettlementBrokerFallback()`
// （src/lib/pricing/settlement-broker-fallback.ts）——batch/route.ts 同
// 單筆 POST /api/shift-records 共用嘅 fallback 鏈第 3-7 級（第 1／2 級
// 「payload／現存記錄」由 caller 自己 `??` 先，呢度唔測）。逐級獨立
// test，確保鏈冇跳級／冇錯用另一級嘅資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { resolveSettlementBrokerFallback } from "@/lib/pricing/settlement-broker-fallback";

async function makeBroker(code: string, kind: "broker" | "internal_cash" | "internal_longterm" = "broker") {
  return prisma.broker.create({
    data: { code, name: `測試${code}`, kind, settlementType: kind === "internal_longterm" ? "salary" : "cash", createdBy: "test:settlement-broker-fallback" },
  });
}
async function makeSite(name: string) {
  return prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:settlement-broker-fallback" } });
}
async function makeGuard(employmentType: "cash_casual" | "longterm_autopay", defaultBrokerId: string | null = null) {
  return prisma.guard.create({
    data: { nameZh: "測試安員", employmentType, defaultBrokerId, createdBy: "test:settlement-broker-fallback" },
  });
}
async function makeShiftType(siteId: string, code = "N") {
  return prisma.shiftType.create({ data: { siteId, code, label: "測試更", hours: 12, createdBy: "test:settlement-broker-fallback" } });
}
async function makeRecord(opts: {
  siteId: string;
  shiftTypeId: string;
  guardId: string;
  workDate: Date;
  settlementBrokerId: string | null;
  status?: "confirmed" | "cancelled";
}) {
  return prisma.shiftRecord.create({
    data: {
      siteId: opts.siteId,
      shiftTypeId: opts.shiftTypeId,
      guardId: opts.guardId,
      workDate: opts.workDate,
      settlementBrokerId: opts.settlementBrokerId,
      operationalBrokerId: opts.settlementBrokerId,
      recordType: "shift",
      status: opts.status ?? "confirmed",
      createdBy: "test:settlement-broker-fallback",
    },
  });
}

describe("resolveSettlementBrokerFallback（第 3-7 級 fallback 鏈）", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("第 3 級：同一安員、同一盤，最近一條非作廢記錄嘅 settlement_broker_id", async () => {
    const brokerOld = await makeBroker("OLD");
    const brokerNew = await makeBroker("NEW");
    const site = await makeSite("盤A");
    const st = await makeShiftType(site.id);
    const guard = await makeGuard("cash_casual");
    await makeRecord({ siteId: site.id, shiftTypeId: st.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 6, 1)), settlementBrokerId: brokerOld.id });
    await makeRecord({ siteId: site.id, shiftTypeId: st.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 7, 15)), settlementBrokerId: brokerNew.id });

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerNew.id); // 最近（8月15）嗰條，唔係 7月1嗰條
  });

  it("第 3 級揀第 4 級之前：同盤記錄就算舊過第 4 級都要贏（第 3 級優先於第 4 級）", async () => {
    const brokerSameSite = await makeBroker("SAME");
    const brokerOtherSite = await makeBroker("OTHER");
    const site = await makeSite("盤A");
    const otherSite = await makeSite("盤B");
    const st = await makeShiftType(site.id);
    const stOther = await makeShiftType(otherSite.id);
    const guard = await makeGuard("cash_casual");
    // 同盤：舊記錄
    await makeRecord({ siteId: site.id, shiftTypeId: st.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 5, 1)), settlementBrokerId: brokerSameSite.id });
    // 另一盤：更新嘅記錄
    await makeRecord({ siteId: otherSite.id, shiftTypeId: stOther.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 8, 1)), settlementBrokerId: brokerOtherSite.id });

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerSameSite.id);
  });

  it("第 4 級：呢個盤冇記錄，但同一安員第啲盤有——用最近嗰條", async () => {
    const brokerOtherSite = await makeBroker("OTHER");
    const site = await makeSite("盤A（冇記錄）");
    const otherSite = await makeSite("盤B");
    const stOther = await makeShiftType(otherSite.id);
    const guard = await makeGuard("cash_casual");
    await makeRecord({ siteId: otherSite.id, shiftTypeId: stOther.id, guardId: guard.id, workDate: new Date(Date.UTC(2026, 7, 1)), settlementBrokerId: brokerOtherSite.id });

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerOtherSite.id);
  });

  it("作廢（cancelled）記錄唔計——淨係睇非作廢記錄", async () => {
    const brokerCancelled = await makeBroker("CANC");
    const brokerDefault = await makeBroker("DEF");
    const site = await makeSite("盤A");
    const st = await makeShiftType(site.id);
    const guard = await makeGuard("cash_casual", brokerDefault.id);
    await makeRecord({
      siteId: site.id,
      shiftTypeId: st.id,
      guardId: guard.id,
      workDate: new Date(Date.UTC(2026, 7, 1)),
      settlementBrokerId: brokerCancelled.id,
      status: "cancelled",
    });

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerDefault.id); // 唔係 brokerCancelled——跌到第 5 級 default_broker_id
  });

  it("第 5 級：乜記錄都冇，跟 guard.default_broker_id", async () => {
    const brokerDefault = await makeBroker("DEF");
    const site = await makeSite("盤A");
    const guard = await makeGuard("cash_casual", brokerDefault.id);

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerDefault.id);
  });

  it("第 6 級：乜記錄、乜 default 都冇，但係長工（longterm_autopay）→ internal_longterm 嗰個 broker", async () => {
    const brokerLongterm = await makeBroker("LT", "internal_longterm");
    await makeBroker("CASH", "internal_cash"); // 混入一個唔啱 kind 嘅 broker，確保揀啱
    const site = await makeSite("盤A");
    const guard = await makeGuard("longterm_autopay", null);

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBe(brokerLongterm.id);
  });

  it("第 7 級：乜都搵唔到（唔係長工）→ null（唔臆測）", async () => {
    const site = await makeSite("盤A");
    const guard = await makeGuard("cash_casual", null);

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBeNull();
  });

  it("長工但搵唔到 internal_longterm broker（資料唔齊）→ null，唔會 throw", async () => {
    const site = await makeSite("盤A");
    const guard = await makeGuard("longterm_autopay", null);

    const result = await resolveSettlementBrokerFallback(
      { guardId: guard.id, siteId: site.id, employmentType: guard.employmentType, defaultBrokerId: guard.defaultBrokerId },
      prisma,
    );
    expect(result).toBeNull();
  });
});
