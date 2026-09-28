// WP-BOSS5 驗收項 2（+ Opus 5.5 覆核應修 a）：PATCH /api/shift-records/[id]
// 改 `ot_hours`（OT 記錄、workDate≥2026-08-01）要用 resolver 用新小時
// 重新計价——唔可以淨改小時唔跟住變金額（snapshot 本身係「每小時价×
// 小時」嘅金額，小時變咗金額要跟住變，否則個「每小時价」會靜靜錯咗）。
//
// 揀嘅做法（見 src/app/api/shift-records/[id]/route.ts PATCH）：
//   0. 帶咗 ot_hours 又帶咗三個 snapshot 欄其中一兩個（唔係三個一齊帶）
//      → 400。
//   1. 冇帶齊三個 snapshot 欄（帶齊就當用戶自己指定成套金額，唔喺呢度
//      插手）、記錄係 OT、workDate≥2026-08-01 先觸發自動重新計价。
//   2. **逐邊獨立判斷**：
//      - 收客價：resolver 揾到收客卡 → 覆蓋；揾唔到但之前非 null → 409；
//        揾唔到而之前已經 null → 維持 null。
//      - 出街價（guard_wage／broker_fee 一組）：同樣邏輯，獨立於收客價
//        嗰邊嘅揾卡結果。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { PATCH as shiftRecordUpdate } from "@/app/api/shift-records/[id]/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("PATCH /api/shift-records/[id]：改 ot_hours 用 resolver 重新計价（WP-BOSS5 驗收項 2 + 應修 a）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let otShiftTypeWithCardId: string;
  let otShiftTypeNoCardId: string;
  let otShiftTypeClientOnlyId: string;
  let otShiftTypePayoutOnlyId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    const otShiftTypeWithCard = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "OT1", label: "1Hr OT", billingGroup: "per_shift", createdBy: "test" },
    });
    otShiftTypeWithCardId = otShiftTypeWithCard.id;
    // 盤級（brokerId/guardId 都 null）OT 卡——收客+出街都有，每小時价 84.85／73。
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

    // 淨係收客卡（冇 guard_wage／broker_fee／payout_rate）——「淨係揾到
    // 收客卡」個 case 用。
    const otShiftTypeClientOnly = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "OT3", label: "1Hr OT（淨收客卡）", billingGroup: "per_shift", createdBy: "test" },
    });
    otShiftTypeClientOnlyId = otShiftTypeClientOnly.id;
    await prisma.rateCard.create({
      data: {
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeClientOnlyId,
        clientRate: 90,
        billingModel: null,
        effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
        createdBy: "test",
      },
    });

    // 淨係出街卡（冇 client_rate）——「淨係揾到出街卡」個 case 用。
    const otShiftTypePayoutOnly = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "OT4", label: "1Hr OT（淨出街卡）", billingGroup: "per_shift", createdBy: "test" },
    });
    otShiftTypePayoutOnlyId = otShiftTypePayoutOnly.id;
    await prisma.rateCard.create({
      data: {
        siteId: fx.site.id,
        shiftTypeId: otShiftTypePayoutOnlyId,
        guardWage: 65,
        billingModel: null,
        effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
        createdBy: "test",
      },
    });
  });

  it("揾到 OT 卡（收客+出街都有）→ 改 ot_hours 觸發三欄覆蓋做「每小時价×新小時」", async () => {
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

  it("淨係揾到收客卡（出街方之前已經 null）→ 收客價覆蓋，出街價維持 null，200", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeClientOnlyId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 180, // 90 × 2
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
    expect(Number(after.clientRateSnapshot)).toBe(270); // round2(90×3)
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
  });

  it("淨係揾到出街卡（收客方之前已經 null）→ 出街價覆蓋，收客維持 null，200", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypePayoutOnlyId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: null,
        guardWageSnapshot: 130, // 65 × 2
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
    expect(Number(after.guardWageSnapshot)).toBe(195); // round2(65×3)
    expect(after.brokerFeeSnapshot).toBeNull();
  });

  it("淨係揾到收客卡，但出街方之前非 null（人手輸入冇對應出街卡）→ 409，DB 完全不變（連收客都唔覆蓋）", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: fx.unlockedMonth,
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeClientOnlyId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 180,
        guardWageSnapshot: 400, // 人手輸入，呢個更種冇對應出街卡
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3 }), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(res.status).toBe(409);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(2);
    expect(Number(after.clientRateSnapshot)).toBe(180); // 完全冇被覆蓋，就算收客卡揾到
    expect(Number(after.guardWageSnapshot)).toBe(400);
  });

  it("帶 ot_hours 同時淨帶一兩個 snapshot 欄（唔係三個一齊）→ 400，DB 不變", async () => {
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
    expect(res.status).toBe(400);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(2); // 完全不變
    expect(Number(after.clientRateSnapshot)).toBe(500);
  });

  it("PATCH 同時帶齊 ot_hours 同三個 snapshot 欄（用戶自己指定金額）→ 唔觸發 resolver，直接用用戶提供嘅值", async () => {
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
      req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", {
        ot_hours: 3,
        client_rate_snapshot: 750,
        guard_wage_snapshot: 600,
        broker_fee_snapshot: 0,
      }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(res.status).toBe(200);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(3);
    expect(Number(after.clientRateSnapshot)).toBe(750); // 用戶提供嘅值，唔係 resolver 計嘅
    expect(Number(after.guardWageSnapshot)).toBe(600);
    expect(Number(after.brokerFeeSnapshot)).toBe(0);
  });

  it("7 月 OT 記錄（workDate < 2026-08-01）改 ot_hours 唔觸發重新計价，就算揾到卡都唔覆蓋", async () => {
    const record = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 15)), // 2026-07-15
        siteId: fx.site.id,
        shiftTypeId: otShiftTypeWithCardId, // 呢個更種本身有卡（84.85／73）
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        recordType: "ot",
        otHours: 2,
        status: "confirmed",
        clientRateSnapshot: 169.7,
        guardWageSnapshot: 146,
        brokerFeeSnapshot: null,
        createdBy: "test",
      },
    });

    const res = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${record.id}`, ownerCookie, "PATCH", { ot_hours: 3.5 }), {
      params: Promise.resolve({ id: record.id }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(Number(after.otHours)).toBe(3.5); // 小時本身照樣可以改
    // snapshot 完全冇被 resolver 碰過（7 月分界日前，維持原值）。
    expect(Number(after.clientRateSnapshot)).toBe(169.7);
    expect(Number(after.guardWageSnapshot)).toBe(146);
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
