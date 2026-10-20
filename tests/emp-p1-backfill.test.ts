// EMP-P1 第 3 部分：回填腳本 scripts/db/backfill-shift-staff-numbers.ts——dry-run 預設、逐月逐類計數、未鎖月寫三欄、
// 已鎖月只寫側表（shift_records 一欄不動）、ambiguous／unresolved 唔寫、冪等、一條 audit summary、金額欄絕對唔掂。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { mkBroker, mkGuard } from "./lib/one-click-auto";
import { backfillShiftStaffNumbers } from "../scripts/db/backfill-shift-staff-numbers";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("EMP-P1 回填 shift_records 工號歸屬", () => {
  let fx: Wp2Fixture;
  let ids: Record<string, string>;
  let cards: Record<string, string>;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    // 清走 fixture 自帶更次，用自己砌嘅受控資料
    await prisma.shiftRecord.deleteMany({});
    const B07 = await mkBroker("SB07BF", "internal_longterm");
    const site = await prisma.site.create({ data: { canonicalName: "測試回填盤MP", clientName: "測試客", billingModel: "per_shift", staffScheme: "MP", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", hours: 12, createdBy: "t" } });
    const siteNoScheme = await prisma.site.create({ data: { canonicalName: "測試回填盤未設", clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    const st2 = await prisma.shiftType.create({ data: { siteId: siteNoScheme.id, code: "D", hours: 12, createdBy: "t" } });
    const gFile = await mkGuard(); // 檔案工號對中
    const gLt = await mkGuard({ employmentType: "longterm_autopay" });
    const gRange = await mkGuard();
    const gSole = await mkGuard();
    const gAmb = await mkGuard();
    const gNone = await mkGuard();
    const mk = (guardId: string, scheme: string, number: string, over: Record<string, unknown> = {}) => prisma.guardStaffNumber.create({ data: { guardId, scheme, number, status: "current", ...over } });
    const cFile = await mk(gFile.id, "U", "U90501");
    const cLt = await mk(gLt.id, "MG", "MG90501");
    const cRange1 = await mk(gRange.id, "MP", "MP90501", { status: "former", validFrom: d("2026-01-01"), validTo: d("2026-06-30") });
    const cRange2 = await mk(gRange.id, "MP", "MP90502", { validFrom: d("2026-07-01") });
    const cSole = await mk(gSole.id, "MP", "MP90503");
    await mk(gAmb.id, "MP", "MP90504");
    await mk(gAmb.id, "MP", "MP90505", { status: "former" });
    cards = { cFile: cFile.id, cLt: cLt.id, cRange1: cRange1.id, cRange2: cRange2.id, cSole: cSole.id };
    const up = await prisma.rosterUpload.create({ data: { month: d("2026-08-01"), siteId: site.id, siteNameRaw: "x", uploaderUserId: fx.userIds["老闆"], fileName: "bf.xlsx", fileSha256: "sha-bf", fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed" } });
    const row = await prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex: 1, workDate: d("2026-08-03"), rawCode: "D", codeKind: "shift", staffNoRaw: "u 90501", guardId: gFile.id, guardMatch: "by_staff_no" } });
    const rec = async (key: string, guardId: string, siteId: string, shiftTypeId: string, date: string, extra: Record<string, unknown> = {}) => {
      const r = await prisma.shiftRecord.create({
        data: { workDate: d(date), siteId, shiftTypeId, guardId, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "shift", status: "confirmed", clientRateSnapshot: 100, guardWageSnapshot: 80, brokerFeeSnapshot: 5, createdBy: "t", ...extra },
      });
      return [key, r.id] as const;
    };
    ids = Object.fromEntries([
      await rec("file", gFile.id, site.id, st.id, "2026-08-03", { provenance: { row_id: row.id, upload_id: up.id } }), // 未鎖月 roster_file
      await rec("lt", gLt.id, site.id, st.id, "2026-08-04", { settlementBrokerId: B07.id, operationalBrokerId: B07.id }), // 未鎖月 longterm
      await rec("rangeA", gRange.id, site.id, st.id, "2026-08-05"), // range → cRange2
      await rec("rangeLocked", gRange.id, site.id, st.id, "2026-06-10"), // 已鎖月（fixture 2026-06 鎖）→ 側表，range → cRange1
      await rec("sole", gSole.id, site.id, st.id, "2026-08-06"),
      await rec("amb", gAmb.id, site.id, st.id, "2026-08-07"),
      await rec("none", gNone.id, site.id, st.id, "2026-08-08"),
      await rec("unsetSite", gSole.id, siteNoScheme.id, st2.id, "2026-08-09"), // 盤未設定 → unresolved
      await rec("cancelled", gSole.id, site.id, st.id, "2026-08-10", { status: "cancelled" }), // 作廢唔處理
    ]);
  });

  const amountsOf = async () => (await prisma.shiftRecord.findMany({ orderBy: { id: "asc" }, select: { id: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true, updatedAt: true } })).map((r) => `${r.id}:${r.clientRateSnapshot}/${r.guardWageSnapshot}/${r.brokerFeeSnapshot}/${r.updatedAt.getTime()}`);

  it("dry-run（預設）：逐月逐類計數、完全唔寫", async () => {
    const before = await amountsOf();
    const r = await backfillShiftStaffNumbers({ apply: false });
    const aug = r.months.find((m) => m.month === "2026-08")!;
    const jun = r.months.find((m) => m.month === "2026-06")!;
    expect(jun).toMatchObject({ locked: true, scanned: 1, range: 1, written: 1 });
    expect(aug).toMatchObject({ locked: false, scanned: 7, roster_file: 1, longterm: 1, range: 1, sole: 1, ambiguous: 1, unresolved: 2, written: 4 });
    expect(await prisma.shiftRecord.count({ where: { staffNumberId: { not: null } } })).toBe(0);
    expect(await prisma.shiftRecordStaffAttribution.count()).toBe(0);
    expect(await amountsOf()).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: "backfill_shift_staff_numbers" } })).toBe(0);
  });

  it("--apply：未鎖月直接寫三欄（source 加 backfill:）；已鎖月只寫側表且 shift_records 一欄不動；ambiguous／unresolved／作廢唔寫；金額欄＋updated_at 完全唔變；一條 audit summary；冪等", async () => {
    const before = await amountsOf();
    const r = await backfillShiftStaffNumbers({ apply: true });
    expect(r.apply).toBe(true);
    const row = (k: string) => prisma.shiftRecord.findUniqueOrThrow({ where: { id: ids[k]! } });
    expect(await row("file")).toMatchObject({ staffNumberId: cards.cFile, staffScheme: "U", staffNumberSource: "backfill:roster_file" });
    expect(await row("lt")).toMatchObject({ staffNumberId: cards.cLt, staffScheme: "MG", staffNumberSource: "backfill:longterm" });
    expect(await row("rangeA")).toMatchObject({ staffNumberId: cards.cRange2, staffNumberSource: "backfill:range" });
    expect(await row("sole")).toMatchObject({ staffNumberId: cards.cSole, staffNumberSource: "backfill:sole" });
    for (const k of ["amb", "none", "unsetSite", "cancelled"]) expect((await row(k)).staffNumberId).toBeNull();
    // 已鎖月：shift_records 不動，側表有行
    expect(await row("rangeLocked")).toMatchObject({ staffNumberId: null, staffScheme: null, staffNumberSource: null });
    const attr = await prisma.shiftRecordStaffAttribution.findMany();
    expect(attr).toHaveLength(1);
    expect(attr[0]).toMatchObject({ shiftRecordId: ids.rangeLocked, staffNumberId: cards.cRange1, staffScheme: "MP", source: "backfill:range" });
    // 金額欄＋updated_at 完全唔變
    expect(await amountsOf()).toEqual(before);
    // 一條 summary audit
    const audits = await prisma.auditLog.findMany({ where: { action: "backfill_shift_staff_numbers" } });
    expect(audits).toHaveLength(1);
    // 冪等：再跑掃描 = 只剩未解決嗰啲，唔重複寫
    const again = await backfillShiftStaffNumbers({ apply: true });
    expect(again.months.reduce((n, m) => n + m.written, 0)).toBe(0);
    expect(await prisma.shiftRecordStaffAttribution.count()).toBe(1);
  });

  it("EMP-P1.1 M1：第一批同第二批之間鎖月 → 之後批次 0 寫入（UPDATE 帶 NOT EXISTS month_closes 鎖月檢查）", async () => {
    // 用未鎖嘅 8 月；chunkSize=1 令每條更次一批；第一批之後鎖 8 月
    let locked = false;
    const r = await backfillShiftStaffNumbers({
      apply: true,
      months: ["2026-08"],
      chunkSize: 1,
      afterBatch: async (i) => {
        if (i === 0 && !locked) {
          locked = true;
          await prisma.monthClose.upsert({ where: { month: d("2026-08-01") }, update: { lockedAt: new Date() }, create: { month: d("2026-08-01"), lockedAt: new Date(), lockedBy: fx.userIds["老闆"] } });
        }
      },
    });
    expect(locked).toBe(true);
    // 8 月可寫嘅有 4 條（file／lt／rangeA／sole），第一批最多寫 1 條，之後鎖月 → 其餘 0 寫入
    const written = await prisma.shiftRecord.count({ where: { staffNumberId: { not: null }, workDate: { gte: d("2026-08-01"), lte: d("2026-08-31") } } });
    expect(written).toBeLessThanOrEqual(1);
    expect(r.months.find((m) => m.month === "2026-08")!.written).toBeGreaterThan(written); // 計數係「計劃寫」，實際被鎖月擋咗
  });

  it("--month 只處理指定月份", async () => {
    const r = await backfillShiftStaffNumbers({ apply: true, months: ["2026-06"] });
    expect(r.months.map((m) => m.month)).toEqual(["2026-06"]);
    expect(await prisma.shiftRecordStaffAttribution.count()).toBe(1);
    expect(await prisma.shiftRecord.count({ where: { staffNumberId: { not: null } } })).toBe(0);
  });
});
