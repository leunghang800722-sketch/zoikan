// HIST-1：scripts/db/leave-opening-from-rosters.ts——由歷史更表（shift_records leaveCode SL／AL）回填長工假期結餘 opening。假資料：測試甲乙、MG9xxxx。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { computeGuardOpening, consecutiveSegments, leaveOpeningFromRosters, parseAsOf } from "../scripts/db/leave-opening-from-rosters";

const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const JUN = D(2026, 6, 1);
const days = (y: number, m: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => D(y, m, from + i));

describe("HIST-1 leave-opening 純函數", () => {
  it("parseAsOf 只收 YYYY-MM；consecutiveSegments 按連續曆日分段", () => {
    expect(parseAsOf("2026-06").toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(() => parseAsOf("2026-6")).toThrow();
    expect(consecutiveSegments([D(2026, 3, 2), D(2026, 3, 3), D(2026, 3, 9)]).map((s) => s.days.length)).toEqual([2, 1]);
  });
  it("SL：結餘夠 → 有薪食結餘；累積 slAccrued（做滿 1 個月先儲、每月 2 日）；opening＝as-of 前一個月月尾累積；AL 去重", () => {
    // 入職 2025-01-01（條例口徑）：2026-03-02 已滿 14 個月＝12×2＋2×4＝32 日；2026-06-30 滿 17 個月＝24＋5×4＝44 日
    const sl = [...days(2026, 3, 2, 4), ...days(2026, 6, 10, 11)];
    const al = [D(2026, 5, 4), D(2026, 5, 4), D(2026, 6, 15)];
    const { n, unpaidSegments } = computeGuardOpening(D(2025, 1, 1), sl, al, JUN);
    expect(unpaidSegments).toBe(0);
    expect(n).toEqual({ alTaken: 2, slTaken: 5, slAccrued: 44, alTakenOpening: 1, slTakenOpening: 3, asOfMonth: "2026-06-01" });
  });
  it("SL：結餘唔夠（入職未滿 1 個月）→ 該段當無薪，唔食結餘；as-of 之後嘅日子唔計；冇入職日 → slAccrued 0", () => {
    const a = computeGuardOpening(D(2026, 6, 1), days(2026, 6, 20, 22), [], JUN);
    expect(a.unpaidSegments).toBe(1);
    expect(a.n.slTaken).toBe(0);
    const b = computeGuardOpening(D(2025, 1, 1), [...days(2026, 6, 28, 30), ...days(2026, 7, 1, 3)], [D(2026, 7, 5)], JUN);
    expect(b.n).toMatchObject({ slTaken: 3, alTaken: 0 });
    const c = computeGuardOpening(null, days(2026, 6, 3, 4), [], JUN);
    expect(c.n).toMatchObject({ slAccrued: 0, slTaken: 0 });
    expect(c.unpaidSegments).toBe(1);
  });
});

describe("HIST-1 leave-opening 腳本（DB）", () => {
  let fx: Wp2Fixture;
  let siteId: string;
  let stId: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
    siteId = fx.site.id;
    stId = fx.shiftType.id;
  });
  const leave = (guardId: string, d: Date, code: "SL" | "AL") =>
    prisma.shiftRecord.create({ data: { workDate: d, siteId, shiftTypeId: stId, guardId, recordType: "leave", leaveCode: code, status: "confirmed", createdBy: "t" } });
  const mkLt = async (name: string, hire: Date | null, mgNo: string) => {
    const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: hire, createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: mgNo, status: "current" } });
    return g;
  };

  it("dry-run 唔寫；--apply 建行（year=as-of 年，alTaken／slTaken 累積、opening＝前一個月月尾、asOfMonth＝as-of）；冪等；散工同冇假期嘅長工唔建行；寫 audit summary", async () => {
    const a = await mkLt("測試甲", D(2025, 1, 1), "MG99901");
    const blank = await mkLt("測試乙", D(2025, 1, 1), "MG99902"); // 有累積病假結餘，冇放假
    const casual = fx.guardB; // 散工，冇 MG 卡冇長工合約
    for (const d of days(2026, 3, 2, 4)) await leave(a.id, d, "SL");
    await leave(a.id, D(2026, 5, 4), "AL");
    await leave(a.id, D(2026, 6, 15), "AL");
    await leave(a.id, D(2026, 7, 1), "SL"); // as-of 之後唔計
    await leave(casual.id, D(2026, 3, 3), "SL");

    const dry = await leaveOpeningFromRosters({ asOf: JUN, apply: false });
    expect(dry.counts).toMatchObject({ guards: 2, create: 2, update: 0 });
    expect(await prisma.guardLeaveBalance.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "backfill_leave_opening" } })).toBe(0);
    expect(dry.rows.find((r) => r.guard_id === a.id)!.computed).toEqual({ alTaken: 2, slTaken: 3, slAccrued: 44, alTakenOpening: 1, slTakenOpening: 3, asOfMonth: "2026-06-01" });
    expect(dry.rows.map((r) => r.guard_id)).not.toContain(casual.id);

    const ap = await leaveOpeningFromRosters({ asOf: JUN, apply: true });
    expect(ap.counts).toMatchObject({ create: 2 });
    const row = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: a.id, year: 2026 } } });
    expect([Number(row.alTaken), Number(row.slTaken), Number(row.slAccrued), Number(row.alTakenOpening), Number(row.slTakenOpening), row.asOfMonth!.toISOString().slice(0, 10)]).toEqual([2, 3, 44, 1, 3, "2026-06-01"]);
    expect(Number((await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: blank.id, year: 2026 } } })).slAccrued)).toBe(44);
    const audits = await prisma.auditLog.findMany({ where: { action: "backfill_leave_opening" } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).not.toMatch(/測試/); // 淨係月份＋計數

    const again = await leaveOpeningFromRosters({ asOf: JUN, apply: true });
    expect(again.counts).toMatchObject({ create: 0, update: 0, skip_existing_newer_or_equal: 2 });
    expect(await prisma.guardLeaveBalance.count()).toBe(2);
  });

  it("已有行：asOfMonth 早過 as-of → 更新（差異清單列現有 vs 計算）；asOfMonth ≥ as-of（計糧已推進）→ 唔郁，只列差異；asOfMonth null → 更新", async () => {
    const old = await mkLt("測試甲", D(2025, 1, 1), "MG99911");
    const newer = await mkLt("測試乙", D(2025, 1, 1), "MG99912");
    const nul = await mkLt("測試丙", D(2025, 1, 1), "MG99913");
    for (const g of [old, newer, nul]) await leave(g.id, D(2026, 4, 6), "AL");
    await prisma.guardLeaveBalance.create({ data: { guardId: old.id, year: 2026, alTaken: 9, asOfMonth: D(2026, 3, 1) } });
    await prisma.guardLeaveBalance.create({ data: { guardId: newer.id, year: 2026, alTaken: 7, slTaken: 2, asOfMonth: D(2026, 9, 1) } });
    await prisma.guardLeaveBalance.create({ data: { guardId: nul.id, year: 2026, alTaken: 5 } });
    const dry = await leaveOpeningFromRosters({ asOf: JUN, apply: false });
    const by = (id: string) => dry.rows.find((r) => r.guard_id === id)!;
    expect([by(old.id).action, by(newer.id).action, by(nul.id).action]).toEqual(["update", "skip_existing_newer_or_equal", "update"]);
    expect(by(old.id).diffs.alTaken).toEqual([9, 1]);
    expect(by(newer.id).diffs.alTaken).toEqual([7, 1]);
    expect(by(newer.id).existing).toMatchObject({ asOfMonth: "2026-09-01", slTaken: 2 });
    await leaveOpeningFromRosters({ asOf: JUN, apply: true });
    const get = (id: string) => prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: id, year: 2026 } } });
    expect(Number((await get(old.id)).alTaken)).toBe(1);
    expect((await get(old.id)).asOfMonth!.toISOString().slice(0, 7)).toBe("2026-06");
    expect(Number((await get(nul.id)).alTaken)).toBe(1);
    expect(Number((await get(newer.id)).alTaken)).toBe(7); // 唔郁
    expect((await get(newer.id)).asOfMonth!.toISOString().slice(0, 7)).toBe("2026-09");
  });

  it("冇入職日 → 標 no_hire_date；有長工合約（冇 MG 卡）都當長工；WhatsApp 未批核唔計", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試丁", employmentType: "longterm_autopay", createdBy: "t" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: D(2025, 1, 1), annualLeaveDays: 7, source: "manual", createdBy: fx.userIds["老闆"] } });
    await leave(g.id, D(2026, 2, 2), "SL");
    await prisma.shiftRecord.create({ data: { workDate: D(2026, 2, 3), siteId, shiftTypeId: stId, guardId: g.id, recordType: "leave", leaveCode: "AL", status: "pending_approval", source: "whatsapp", createdBy: "t" } });
    const r = await leaveOpeningFromRosters({ asOf: JUN, apply: false });
    const row = r.rows.find((x) => x.guard_id === g.id)!;
    expect(row.flags).toContain("no_hire_date");
    expect(row.computed).toMatchObject({ alTaken: 0, slTaken: 0, slAccrued: 0 });
    expect(r.counts.no_hire_date).toBe(1);
  });

  it("HIST-1.1 --merge-into-existing：已有較新行（asOfMonth 9 月）→ 歷史累積加落現有 alTaken／slTaken／兩個 opening，slAccrued 重算到 9 月，asOfMonth 不變；dry-run 列前後值；再跑 already_merged（audit 防重複）；冇旗就 skip", async () => {
    const g = await mkLt("測試甲", D(2025, 1, 1), "MG99921");
    for (const d of days(2026, 3, 2, 4)) await leave(g.id, d, "SL"); // 3 日有薪
    await leave(g.id, D(2026, 5, 4), "AL");
    await leave(g.id, D(2026, 6, 15), "AL");
    await prisma.guardLeaveBalance.create({ data: { guardId: g.id, year: 2026, alTaken: 1, slTaken: 2, slAccrued: 99, alTakenOpening: 0, slTakenOpening: 1, asOfMonth: D(2026, 9, 1) } });
    const plain = await leaveOpeningFromRosters({ asOf: JUN, apply: false });
    expect(plain.rows[0]!.action).toBe("skip_existing_newer_or_equal");
    const dry = await leaveOpeningFromRosters({ asOf: JUN, apply: false, mergeIntoExisting: true });
    const row = dry.rows[0]!;
    expect(row.action).toBe("merge");
    expect(row.existing).toMatchObject({ alTaken: 1, slTaken: 2, alTakenOpening: 0, slTakenOpening: 1, asOfMonth: "2026-09-01" });
    expect(row.computed).toMatchObject({ alTaken: 3, slTaken: 5, alTakenOpening: 1, slTakenOpening: 4, asOfMonth: "2026-09-01" });
    expect(row.diffs.alTaken).toEqual([1, 3]);
    const get = () => prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: g.id, year: 2026 } } });
    expect(Number((await get()).alTaken)).toBe(1); // dry-run 唔寫
    const ap = await leaveOpeningFromRosters({ asOf: JUN, apply: true, mergeIntoExisting: true });
    expect(ap.counts.merge).toBe(1);
    const after = await get();
    expect([Number(after.alTaken), Number(after.slTaken), Number(after.alTakenOpening), Number(after.slTakenOpening), after.asOfMonth!.toISOString().slice(0, 10)]).toEqual([3, 5, 1, 4, "2026-09-01"]);
    expect(Number(after.slAccrued)).toBe(40); // 入職 2025-01-01 至 2026-09-30＝20 個月，9 月仍用舊口徑每月 2 日（生效日 10-01 前）
    expect(await prisma.auditLog.count({ where: { action: "backfill_leave_opening_merge", rowId: g.id } })).toBe(1);
    const again = await leaveOpeningFromRosters({ asOf: JUN, apply: true, mergeIntoExisting: true });
    expect(again.counts).toMatchObject({ merge: 0, already_merged: 1 });
    expect(Number((await get()).alTaken)).toBe(3);
  });

  it("HIST-1.1 --recompute-same-as-of：已有行 asOfMonth＝as-of → 覆蓋重算（冇旗就 skip）", async () => {
    const g = await mkLt("測試甲", D(2025, 1, 1), "MG99922");
    await leave(g.id, D(2026, 5, 4), "AL");
    await leaveOpeningFromRosters({ asOf: JUN, apply: true });
    await leave(g.id, D(2026, 6, 5), "AL"); // 補上載咗更多
    expect((await leaveOpeningFromRosters({ asOf: JUN, apply: false })).rows[0]!.action).toBe("skip_existing_newer_or_equal");
    const r = await leaveOpeningFromRosters({ asOf: JUN, apply: true, recomputeSameAsOf: true });
    expect(r.rows[0]!.action).toBe("update");
    expect(Number((await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { guardId_year: { guardId: g.id, year: 2026 } } })).alTaken)).toBe(2);
  });
});
