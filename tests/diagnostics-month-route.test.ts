// WP-MONTH-DIAG（老闆 2026-09-27 緊急）：`GET /api/diagnostics/month`
// route-level 測試——權限（淨係老闆 200，主管/會計/雞頭 403）、有齊 key、
// 快樂路徑金額、**冇 PII**（response JSON stringify 用 dev DB 真實姓名/
// 電話掃描為 0）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as diagnosticsRoute } from "@/app/api/diagnostics/month/route";

function req(cookie: string, month: string) {
  return new Request(`http://test.local/api/diagnostics/month?month=${month}`, { headers: { cookie } });
}

describe("GET /api/diagnostics/month", () => {
  let fx: Wp2Fixture;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("老闆：200，有齊頂層 key，逐雞頭更數/應付啱數", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(req(cookie, "2026-08"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    for (const key of ["month", "brokers", "longterm", "referral", "unpriced", "sites", "uploads", "cards", "ot", "expected_dev_baseline"]) {
      expect(json).toHaveProperty(key);
    }
    expect(json.month).toBe("2026-08");

    const brokers = json.brokers as Array<Record<string, unknown>>;
    // fixture 嘅 shiftRecordA 掛喺 brokerA（settlement=brokerA），8 月，
    // client=999／wage=700／fee=50——搵返嗰行核對埋 shift_count/payout_total。
    const brokerACode = (await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } })).code;
    const row = brokers.find((b) => b.code === brokerACode);
    expect(row).toBeDefined();
    expect(row!.shift_count).toBe(1);
    expect(row!.payout_total).toBe(750);
    expect(row!.client_total).toBe(999);
    expect(row!.null_wage_count).toBe(0);
    expect(row!.null_client_count).toBe(0);
  });

  it("老闆：長工/介紹費/未定價/上載/卡 各段有數（快樂路徑）", async () => {
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07", name: "測試B07", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
    const referredGuard = await prisma.guard.create({
      data: { nameZh: "測試長工", employmentType: "longterm_autopay", referralBrokerId: fx.brokerA.id, createdBy: "t" },
    });
    await prisma.guardLongtermPost.create({
      data: { guardId: referredGuard.id, siteId: fx.site.id, effectiveFrom: new Date("2026-01-01"), source: "manual", createdBy: "t" },
    });
    await prisma.referralFeeRate.create({ data: { brokerId: fx.brokerA.id, siteId: null, month: new Date("2026-08-01"), feePerShift: 100, createdBy: "t" } });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date("2026-08-05"),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: referredGuard.id,
        settlementBrokerId: b07.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
      },
    });
    await prisma.specialItem.create({
      data: { month: new Date("2026-08-01"), brokerId: fx.brokerA.id, kind: "referral_fee", shifts: 1, cost: 100, createdBy: "t" },
    });

    const upload = await prisma.rosterUpload.create({
      data: {
        month: new Date("2026-08-01"),
        siteId: fx.site.id,
        siteNameRaw: fx.site.name,
        uploaderUserId: fx.userIds["老闆"],
        fileName: "test.xlsx",
        fileSha256: "abc",
        fileBytes: Buffer.from("x"),
        fileSize: 1,
        status: "confirmed",
        createdBy: "t",
      },
    });
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 1, workDate: new Date("2026-08-05"), rawCode: "N", codeKind: "shift", guardMatch: "unmatched" },
    });

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(req(cookie, "2026-08"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    const longterm = json.longterm as Record<string, unknown>;
    expect(longterm.active_posts).toBe(1);
    expect(longterm.longterm_guards).toBe(1);
    expect(longterm.b07_shift_count).toBe(1);
    expect(longterm.referral_broker_set_count).toBe(1);
    expect(longterm.referral_broker_null_count).toBe(0);

    const referral = json.referral as Record<string, unknown>;
    expect(referral.total_amount).toBe(100);
    const referralItems = referral.items as Array<Record<string, unknown>>;
    expect(referralItems.length).toBe(1);
    expect(referralItems[0]!.amount).toBe(100);

    const uploads = json.uploads as Record<string, unknown>;
    expect(uploads.active_count).toBe(1);
    expect(uploads.confirmed_count).toBe(1);
    expect(uploads.rows_unmatched).toBe(1);

    const expectedBaseline = json.expected_dev_baseline as Record<string, unknown>;
    expect(expectedBaseline.applicable).toBe(true);
    const byUnit = expectedBaseline.by_unit as Array<Record<string, unknown>>;
    expect(byUnit.length).toBe(6);
  });

  // WP-BOSS5 驗收項 7（新增診斷）：本月 OT 記錄逐 ot_hours 值嘅 {count,
  // pricedCount}——一條 1 小時已定价、一條 3.5 小時已定价、一條 3.5
  // 小時未定价（三個 snapshot 全 null）、一條未填 ot_hours（null）。
  it("老闆：ot 區塊逐 ot_hours 值分組，priced 判斷同 otHourlyPricingFrom 正確", async () => {
    const otShiftType = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "OT1", label: "1Hr OT", createdBy: "t" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試OT安員", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.shiftRecord.createMany({
      data: [
        {
          workDate: new Date("2026-08-03"),
          siteId: fx.site.id,
          shiftTypeId: otShiftType.id,
          guardId: guard.id,
          settlementBrokerId: fx.brokerA.id,
          recordType: "ot",
          otHours: 1,
          clientRateSnapshot: 84.85,
          guardWageSnapshot: 73,
          createdBy: "t",
        },
        {
          workDate: new Date("2026-08-04"),
          siteId: fx.site.id,
          shiftTypeId: otShiftType.id,
          guardId: guard.id,
          settlementBrokerId: fx.brokerA.id,
          recordType: "ot",
          otHours: 3.5,
          clientRateSnapshot: 296.98,
          guardWageSnapshot: 255.5,
          createdBy: "t",
        },
        {
          workDate: new Date("2026-08-05"),
          siteId: fx.site.id,
          shiftTypeId: otShiftType.id,
          guardId: guard.id,
          settlementBrokerId: fx.brokerA.id,
          recordType: "ot",
          otHours: 3.5,
          createdBy: "t", // 冇任何 snapshot ＝未定价
        },
        {
          workDate: new Date("2026-08-06"),
          siteId: fx.site.id,
          shiftTypeId: otShiftType.id,
          guardId: guard.id,
          settlementBrokerId: fx.brokerA.id,
          recordType: "ot",
          otHours: null,
          createdBy: "t", // 未填 ot_hours
        },
      ],
    });

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(req(cookie, "2026-08"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    const ot = json.ot as Record<string, unknown>;
    expect(ot.ot_hourly_pricing_from).toBe("2026-08-01");
    const byHours = ot.by_hours as Array<Record<string, unknown>>;

    const hour1 = byHours.find((g) => g.ot_hours === 1);
    expect(hour1).toEqual({ ot_hours: 1, count: 1, priced_count: 1 });

    const hour35 = byHours.find((g) => g.ot_hours === 3.5);
    expect(hour35).toEqual({ ot_hours: 3.5, count: 2, priced_count: 1 }); // 一條已定价、一條未定价

    const hourNull = byHours.find((g) => g.ot_hours === null);
    expect(hourNull).toEqual({ ot_hours: null, count: 1, priced_count: 0 });
  });

  it("非 8 月：expected_dev_baseline.applicable=false", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(req(cookie, "2026-07"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const expectedBaseline = json.expected_dev_baseline as Record<string, unknown>;
    expect(expectedBaseline.applicable).toBe(false);
  });

  it("主管／會計／雞頭：403", async () => {
    for (const role of ["主管", "會計", "雞頭"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res = await diagnosticsRoute(req(cookie, "2026-08"));
      expect(res.status).toBe(403);
    }
  });

  it("冇 month：400", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(new Request("http://test.local/api/diagnostics/month", { headers: { cookie } }));
    expect(res.status).toBe(400);
  });

  it("冇 PII：response JSON 唔含 dev DB 任何真實姓名／電話", async () => {
    const referredGuard = await prisma.guard.create({
      data: { nameZh: "測試絕密長工姓名", tel: "61234567", employmentType: "longterm_autopay", referralBrokerId: fx.brokerA.id, createdBy: "t" },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date("2026-08-06"),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: referredGuard.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
      },
    });

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await diagnosticsRoute(req(cookie, "2026-08"));
    expect(res.status).toBe(200);
    const text = await res.text();

    // 掃描全部 dev DB guards 嘅姓名/電話/身份證——一個都唔准出現喺 response。
    const guards = await prisma.guard.findMany({ select: { nameZh: true, nameEn: true, tel: true, hkid: true, staffNo: true } });
    for (const g of guards) {
      if (g.nameZh) expect(text.includes(g.nameZh)).toBe(false);
      if (g.nameEn) expect(text.includes(g.nameEn)).toBe(false);
      if (g.tel) expect(text.includes(g.tel)).toBe(false);
      if (g.hkid) expect(text.includes(g.hkid)).toBe(false);
    }
  });
});
