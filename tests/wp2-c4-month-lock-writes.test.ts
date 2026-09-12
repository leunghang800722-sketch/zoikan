// Opus 對抗式驗收 C4：月鎖補漏——rate-cards POST/PATCH/VOID/UNVOID 以
// effective_from 月份判斷；daily-requirements／special-items 嘅 UNVOID
// 之前漏咗 check。呢個檔案窮舉晒 shift-records／rate-cards／
// daily-requirements／special-items 四個資源 × create/update/void/unvoid
// 一共 16 種寫入，喺已鎖定月份（fx.lockedMonth＝2026-06）全部斷言 403。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";

import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { PATCH as shiftRecordUpdate } from "@/app/api/shift-records/[id]/route";
import { POST as shiftRecordVoid } from "@/app/api/shift-records/[id]/void/route";
import { POST as shiftRecordUnvoid } from "@/app/api/shift-records/[id]/unvoid/route";

import { POST as rateCardCreate } from "@/app/api/rate-cards/route";
import { PATCH as rateCardUpdate } from "@/app/api/rate-cards/[id]/route";
import { POST as rateCardVoid } from "@/app/api/rate-cards/[id]/void/route";
import { POST as rateCardUnvoid } from "@/app/api/rate-cards/[id]/unvoid/route";

import { POST as dailyReqCreate } from "@/app/api/daily-requirements/route";
import { PATCH as dailyReqUpdate } from "@/app/api/daily-requirements/[id]/route";
import { POST as dailyReqVoid } from "@/app/api/daily-requirements/[id]/void/route";
import { POST as dailyReqUnvoid } from "@/app/api/daily-requirements/[id]/unvoid/route";

import { POST as specialItemCreate } from "@/app/api/special-items/route";
import { PATCH as specialItemUpdate } from "@/app/api/special-items/[id]/route";
import { POST as specialItemVoid } from "@/app/api/special-items/[id]/void/route";
import { POST as specialItemUnvoid } from "@/app/api/special-items/[id]/unvoid/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 C4：月鎖補漏——16 種寫入喺鎖定月全部 403", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  // 喺鎖定月（2026-06）入面嘅「已存在」record，專登喺呢個 beforeEach 度
  // 直接用 prisma 建（唔經 API，因為 API 本身寫入已鎖定月就會俾拒），等
  // update/void/unvoid 呢幾個動作有嘢好操作。
  let lockedShiftRecordId: string;
  let lockedRateCardId: string;
  let lockedDailyReqId: string;
  let lockedSpecialItemId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    const lockedGuard = await prisma.guard.create({ data: { nameZh: "測試鎖定月安員", employmentType: "cash_casual", createdBy: "test" } });
    const sr = await prisma.shiftRecord.create({
      data: {
        workDate: fx.lockedMonth,
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: lockedGuard.id,
        recordType: "shift",
        createdBy: "test",
      },
    });
    lockedShiftRecordId = sr.id;

    const rc = await prisma.rateCard.create({
      data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, clientRate: 111, guardWage: 90, effectiveFrom: fx.lockedMonth, createdBy: "test" },
    });
    lockedRateCardId = rc.id;

    const dr = await prisma.dailyRequirement.create({
      data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, workDate: fx.lockedMonth, headcountRequired: 2, createdBy: "test" },
    });
    lockedDailyReqId = dr.id;

    const si = await prisma.specialItem.create({ data: { month: fx.lockedMonth, kind: "other", cost: 100, createdBy: "test" } });
    lockedSpecialItemId = si.id;
  });

  const lockedDateStr = "2026-06-15";

  it("shift-records：create/update/void/unvoid 喺鎖定月全部 403（4/16）", async () => {
    const createRes = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: lockedDateStr,
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(createRes.status, "shift-records create").toBe(403);

    const updateRes = await shiftRecordUpdate(req(`http://test.local/api/shift-records/${lockedShiftRecordId}`, ownerCookie, "PATCH", { ot_hours: 1 }), {
      params: Promise.resolve({ id: lockedShiftRecordId }),
    });
    expect(updateRes.status, "shift-records update").toBe(403);

    const voidRes = await shiftRecordVoid(req(`http://test.local/api/shift-records/${lockedShiftRecordId}`, ownerCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: lockedShiftRecordId }),
    });
    expect(voidRes.status, "shift-records void").toBe(403);

    const unvoidRes = await shiftRecordUnvoid(req(`http://test.local/api/shift-records/${lockedShiftRecordId}`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: lockedShiftRecordId }),
    });
    expect(unvoidRes.status, "shift-records unvoid").toBe(403);
  });

  it("rate-cards：create/update/void/unvoid 以 effective_from 判斷，鎖定月全部 403（4/16）", async () => {
    const createRes = await rateCardCreate(
      req("http://test.local/api/rate-cards", ownerCookie, "POST", { site_id: fx.site.id, effective_from: lockedDateStr, client_rate: 500, guard_wage: 400 }),
    );
    expect(createRes.status, "rate-cards create").toBe(403);

    const updateRes = await rateCardUpdate(req(`http://test.local/api/rate-cards/${lockedRateCardId}`, ownerCookie, "PATCH", { guard_wage: 95 }), {
      params: Promise.resolve({ id: lockedRateCardId }),
    });
    expect(updateRes.status, "rate-cards update").toBe(403);

    const voidRes = await rateCardVoid(req(`http://test.local/api/rate-cards/${lockedRateCardId}`, ownerCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: lockedRateCardId }),
    });
    expect(voidRes.status, "rate-cards void").toBe(403);

    const unvoidRes = await rateCardUnvoid(req(`http://test.local/api/rate-cards/${lockedRateCardId}`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: lockedRateCardId }),
    });
    expect(unvoidRes.status, "rate-cards unvoid").toBe(403);
  });

  it("daily-requirements：create/update/void/unvoid 鎖定月全部 403（4/16，unvoid 之前漏咗）", async () => {
    const createRes = await dailyReqCreate(
      req("http://test.local/api/daily-requirements", ownerCookie, "POST", {
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        work_date: lockedDateStr,
        headcount_required: 3,
      }),
    );
    expect(createRes.status, "daily-requirements create").toBe(403);

    const updateRes = await dailyReqUpdate(req(`http://test.local/api/daily-requirements/${lockedDailyReqId}`, ownerCookie, "PATCH", { headcount_required: 5 }), {
      params: Promise.resolve({ id: lockedDailyReqId }),
    });
    expect(updateRes.status, "daily-requirements update").toBe(403);

    const voidRes = await dailyReqVoid(req(`http://test.local/api/daily-requirements/${lockedDailyReqId}`, ownerCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: lockedDailyReqId }),
    });
    expect(voidRes.status, "daily-requirements void").toBe(403);

    const unvoidRes = await dailyReqUnvoid(req(`http://test.local/api/daily-requirements/${lockedDailyReqId}`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: lockedDailyReqId }),
    });
    expect(unvoidRes.status, "daily-requirements unvoid（呢個之前漏咗 check）").toBe(403);
  });

  it("special-items：create/update/void/unvoid 鎖定月全部 403（4/16，unvoid 之前漏咗）", async () => {
    const createRes = await specialItemCreate(
      req("http://test.local/api/special-items", ownerCookie, "POST", { month: lockedDateStr, kind: "other", cost: 50 }),
    );
    expect(createRes.status, "special-items create").toBe(403);

    const updateRes = await specialItemUpdate(req(`http://test.local/api/special-items/${lockedSpecialItemId}`, ownerCookie, "PATCH", { cost: 60 }), {
      params: Promise.resolve({ id: lockedSpecialItemId }),
    });
    expect(updateRes.status, "special-items update").toBe(403);

    const voidRes = await specialItemVoid(req(`http://test.local/api/special-items/${lockedSpecialItemId}`, ownerCookie, "POST", { reason: "test" }), {
      params: Promise.resolve({ id: lockedSpecialItemId }),
    });
    expect(voidRes.status, "special-items void").toBe(403);

    const unvoidRes = await specialItemUnvoid(req(`http://test.local/api/special-items/${lockedSpecialItemId}`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: lockedSpecialItemId }),
    });
    expect(unvoidRes.status, "special-items unvoid（呢個之前漏咗 check）").toBe(403);
  });
});
