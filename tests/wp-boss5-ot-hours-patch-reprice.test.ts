// WP-BOSS5 驗收項 2：PATCH /api/shift-records/[id] 改 `ot_hours`（OT 記錄、
// workDate≥2026-08-01）要用 resolver 用新小時重新計价——唔可以淨改小時
// 唔跟住變金額（snapshot 本身係「每小時价×小時」嘅金額，小時變咗金額
// 要跟住變，否則個「每小時价」會靜靜錯咗）。
//
// 揀嘅做法（見 src/app/api/shift-records/[id]/route.ts PATCH）：
//   1. 揾到 OT 卡 → 三欄覆蓋做「每小時价×新小時」；
//   2. 揾唔到卡、之前三欄本身已經全部 null（本來就係未定价 OT）→ 維持
//      三欄 null；
//   3. 揾唔到卡、之前三欄任一非 null（呢筆金額冇對應卡，即係人手輸入／
//      卡刪咗）→ 409，要求用戶先清空三欄先改小時。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { PATCH as shiftRecordUpdate } from "@/app/api/shift-records/[id]/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("PATCH /api/shift-records/[id]：改 ot_hours 用 resolver 重新計价（WP-BOSS5 驗收項 2）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let otShiftTypeWithCardId: string;
  let otShiftTypeNoCardId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    const otShiftTypeWithCard = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "OT1", label: "1Hr OT", billingGroup: "per_shift", createdBy: "test" },
    });
    otShiftTypeWithCardId = otShiftTypeWithCard.id;
    // 盤級（brokerId/guardId 都 null）OT 卡——每小時价 84.85／73。
    await prisma.rateCard.create({
      data: {
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeWithCardId,
        clientRate: 84.85,
        guardWage: 73,
        billingModel: null,
        effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
        createdBy: "test",
      },
    });

    const otShiftTypeNoCard = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "OT2", label: "1Hr OT（冇卡）", billingGroup: "per_shift", createdBy: "test" },
    });
    otShiftTypeNoCardId = otShiftTypeNoCard.id;
  });

  it("揾到 OT 卡 → 改 ot_hours 觸發三欄覆蓋做「每小時价×新小時」", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth, // 2026-08-01
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeWithCardId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 169.7, // 84.85 × 2
        guardWageSnapshot: 146, // 73 × 2
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3.5 }), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(3.5);
    expect(Number(after.clientRateSnapshot)).toBe(296.97); // round2(84.85×3.5)
    expect(Number(after.guardWageSnapshot)).toBe(255.5); // 73×3.5
    expect(after.brokerFeeSnapshot).toBeNull(); // 卡冇拆 broker_fee，維持 null
  });

  it("揾唔到卡、之前三欄本身全部 null（本來未定价）→ 改 ot_hours 成功，三欄維持 null", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeNoCardId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: null,
        guardWageSnapshot: null,
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3 }), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(3);
    expect(after.clientRateSnapshot).toBeNull();
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
  });

  it("揾唔到卡、之前三欄任一非 null（人手輸入冇對應卡）→ 409，DB 不變", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeNoCardId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 500, // 人手輸入，冇對應卡
        guardWageSnapshot: 400,
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3 }), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(res.status).toBe(409);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(2); // 完全不變
    expect(Number(after.clientRateSnapshot)).toBe(500);
    expect(Number(after.guardWageSnapshot)).toBe(400);
  });

  it("PATCH 同時帶 ot_hours 同 client_rate_snapshot（用戶自己指定金額）→ 唔觸發 resolver，直接用用戶提供嘅值", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeNoCardId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 500,
        guardWageSnapshot: 400,
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(
      req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3, client_rate_snapshot: 750 }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(res.status).toBe(200);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(3);
    expect(Number(after.clientRateSnapshot)).toBe(750); // 用戶提供嘅值，唔係 resolver 計嘅
  });

  it("正更記錄（record_type=shift）改 ot_hours 唔觸發 OT 重新計价邏輯", async () => {
    // fx.shiftRecordA 係正更（recordType=shift），呢度淨係想證明呢個分支
    // 唔會炸（正更記錄本身唔應該有 ot_hours，但 PATCH 唔應該因為呢個
    // 分支噴錯）。
    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${fx.shiftRecordA.id}`, ownerCookie, "PATCH", { ot_hours: 1 }), {
      params: Promise.resolve({ id: fx.shiftRecordA.id }),
    });
    expect(res.status).toBe(200);
  });
});
