// EMP-P3 第 1 部分：resolveLongtermPeriod（MG 卡鏈聘用段）＋ aggregate 改讀（2026-10 起）＋警告先行＋再入職出糧／結餘。
// 合成資料（測試甲乙／MG9xxxx），唔讀 data/。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";
import { LONGTERM_CARD_DATES_EFFECTIVE_FROM, resolveLongtermPeriod, type PeriodCard } from "@/lib/longterm-payroll/employment-period";

const D = (m: number, d: number, y = 2026) => new Date(Date.UTC(y, m - 1, d));
const OCT = D(10, 1);
const SEP = D(9, 1);
const card = (id: string, over: Partial<PeriodCard> = {}): PeriodCard => ({ id, scheme: "MG", status: "current", validFrom: null, validTo: null, endReason: null, predecessorId: null, ...over });
const g = (hire: Date | null, leave: Date | null = null) => ({ id: "G1", hireDate: hire, leaveDate: leave });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("resolveLongtermPeriod（純函數）", () => {
  it("生效月 2026-10-01；之前月份完全讀人卡（卡有日期都唔理）", () => {
    expect(iso(LONGTERM_CARD_DATES_EFFECTIVE_FROM)).toBe("2026-10-01");
    const p = resolveLongtermPeriod(g(D(1, 1), D(8, 31)), [card("a", { validFrom: D(5, 5) })], SEP);
    expect(p).toMatchObject({ usedCards: false, startSource: "guard", endSource: "guard", warnings: [] });
    expect(iso(p.start)).toBe("2026-01-01");
    expect(iso(p.end)).toBe("2026-08-31");
  });

  it("四種 fallback：卡有起點無終點／卡冇日期／人卡冇日期／兩邊都冇", () => {
    // 卡有 valid_from、人卡有 leave_date（卡 current 冇 valid_to）→ 起點用卡、終點 fallback 人卡
    let p = resolveLongtermPeriod(g(D(1, 1), D(12, 31)), [card("a", { validFrom: D(2, 2) })], OCT);
    expect([iso(p.start), p.startSource, iso(p.end), p.endSource]).toEqual(["2026-02-02", "card", "2026-12-31", "guard"]);
    // 卡冇日期 → 全部 fallback 人卡（唔算 mismatch）
    p = resolveLongtermPeriod(g(D(1, 1), null), [card("a")], OCT);
    expect([iso(p.start), p.startSource, p.end, p.endSource, p.warnings]).toEqual(["2026-01-01", "guard", null, null, []]);
    // 人卡冇日期、卡有 → 用卡
    p = resolveLongtermPeriod(g(null, null), [card("a", { validFrom: D(3, 3) })], OCT);
    expect([iso(p.start), p.startSource, p.warnings]).toEqual(["2026-03-03", "card", []]);
    // 兩邊都冇
    p = resolveLongtermPeriod(g(null, null), [card("a")], OCT);
    expect([p.start, p.end, p.startSource, p.endSource]).toEqual([null, null, null, null]);
    // 完全冇 MG 卡（或者只有 U 卡）→ 純人卡
    p = resolveLongtermPeriod(g(D(1, 1), null), [card("u", { scheme: "U", validFrom: D(5, 5) })], OCT);
    expect([p.usedCards, iso(p.start)]).toEqual([false, "2026-01-01"]);
  });

  it("兩邊都有而唔一致 → 用卡＋warning card_guard_date_mismatch（帶 guardId＋兩個日期）；一致就冇警告", () => {
    const p = resolveLongtermPeriod(g(D(1, 1), D(9, 30)), [card("a", { status: "former", validFrom: D(1, 2), validTo: D(10, 5), endReason: "resigned" })], OCT);
    expect([iso(p.start), iso(p.end)]).toEqual(["2026-01-02", "2026-10-05"]);
    expect(p.warnings).toEqual([
      { code: "card_guard_date_mismatch", guardId: "G1", field: "hire", cardDate: "2026-01-02", guardDate: "2026-01-01" },
      { code: "card_guard_date_mismatch", guardId: "G1", field: "leave", cardDate: "2026-10-05", guardDate: "2026-09-30" },
    ]);
    const same = resolveLongtermPeriod(g(D(1, 2), D(10, 5)), [card("a", { status: "former", validFrom: D(1, 2), validTo: D(10, 5), endReason: "resigned" })], OCT);
    expect(same.warnings).toEqual([]);
  });

  it("鏈跨 replaced：起點＝鏈最早一張卡 valid_from；replaced 唔係終點；終點只認鏈尾 resigned", () => {
    const a = card("a", { status: "former", validFrom: D(1, 1), validTo: D(6, 30), endReason: "replaced" });
    const b = card("b", { predecessorId: "a", validFrom: D(7, 1) });
    let p = resolveLongtermPeriod(g(null, null), [a, b], OCT);
    expect([iso(p.start), p.end, p.chainCardIds]).toEqual(["2026-01-01", null, ["a", "b"]]);
    // 鏈尾 resigned → 終點；cancelled／舊 null 唔係終點
    const bR = { ...b, status: "former" as const, validTo: D(10, 10), endReason: "resigned" };
    p = resolveLongtermPeriod(g(null, null), [a, bR], OCT);
    expect(iso(p.end)).toBe("2026-10-10");
    p = resolveLongtermPeriod(g(null, D(11, 11)), [a, { ...bR, endReason: "cancelled" }], OCT);
    expect([p.end && iso(p.end), p.endSource]).toEqual(["2026-11-11", "guard"]);
    p = resolveLongtermPeriod(g(null, null), [a, { ...bR, endReason: null }], OCT);
    expect(p.end).toBeNull();
  });

  it("再入職：人卡 leave_date 早過當前鏈起點 → 第二段聘用，舊 leave_date 忽略，warning rehire_detected（無 mismatch 噪音）", () => {
    const first = card("a", { status: "former", validFrom: D(1, 1, 2020), validTo: D(3, 31), endReason: "resigned" });
    const second = card("b", { validFrom: D(9, 15) }); // 重新入職：新鏈冇 predecessor
    const p = resolveLongtermPeriod(g(D(1, 1, 2020), D(3, 31)), [first, second], OCT);
    expect(p.rehire).toBe(true);
    expect([iso(p.start), p.end, p.chainCardIds]).toEqual(["2026-09-15", null, ["b"]]);
    expect(p.warnings).toEqual([{ code: "rehire_detected", guardId: "G1", cardDate: "2026-09-15", guardDate: "2026-03-31" }]);
    // 揀鏈：9 月（生效前）仍讀人卡；2026-03 之前嘅月份（假設生效後）揀返第一條鏈
    expect(resolveLongtermPeriod(g(D(1, 1, 2020), D(3, 31)), [first, second], D(3, 1, 2027)).chainCardIds).toEqual(["b"]);
  });
});

async function base() {
  await clearAll();
  const site = await prisma.site.create({ data: { canonicalName: `測試P3盤-${Math.random().toString(36).slice(2, 7)}`, clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
  const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
  const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "t" } });
  const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
  const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "t" } });
  return { site, st, b07, actor: user.id };
}
type Base = Awaited<ReturnType<typeof base>>;
const guard = (name: string, hire: Date | null, leave: Date | null = null) => prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: hire, leaveDate: leave, createdBy: "t" } });
const contract = (b: Base, guardId: string, from: Date, to: Date | null = null) => prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15500, effectiveFrom: from, effectiveTo: to, annualLeaveDays: 7, source: "manual", createdBy: b.actor } });
const shifts = async (b: Base, guardId: string, month: number, from: number, to: number) => {
  for (let d = from; d <= to; d++) await prisma.shiftRecord.create({ data: { workDate: D(month, d), siteId: b.site.id, shiftTypeId: b.st.id, guardId, settlementBrokerId: b.b07.id, operationalBrokerId: b.b07.id, recordType: "shift", createdBy: "t" } });
};
const mg = (guardId: string, number: string, over: Record<string, unknown> = {}) => prisma.guardStaffNumber.create({ data: { guardId, scheme: "MG", number, status: "current", ...over } });

describe("aggregate 改讀 MG 卡日期（2026-10 起）", () => {
  it("同一個『人卡 hire 10/1、MG 卡 valid_from 10/16』個案：10 月跟卡（同人卡 hire=10/16 嘅對照一致）；9 月（生效前）仍讀人卡", async () => {
    const b = await base();
    const viaCard = await guard("測試甲", D(10, 1));
    await contract(b, viaCard.id, D(10, 1));
    await mg(viaCard.id, "MG90601", { validFrom: D(10, 16) });
    const control = await guard("測試乙", D(10, 16));
    await contract(b, control.id, D(10, 1));
    await shifts(b, viaCard.id, 10, 16, 31);
    await shifts(b, control.id, 10, 16, 31);
    const oct = await buildLongtermPayrollInputs(OCT);
    const a = oct.lines.find((l) => l.guardId === viaCard.id)!;
    const c = oct.lines.find((l) => l.guardId === control.id)!;
    expect(a.netBasic).toBe(c.netBasic);
    expect(a.netBasic).toBeLessThan(15500);
    expect(oct.warnings.some((w) => w.includes("card_guard_date_mismatch") && w.includes(viaCard.id))).toBe(true);
    // 9 月：同一個人、同樣卡——生效前讀人卡 hire=10/1（9 月冇在職）→ 唔出糧（同舊行為一致），亦冇 mismatch 警告
    const sep = await buildLongtermPayrollInputs(SEP);
    expect(sep.lines.find((l) => l.guardId === viaCard.id)).toBeUndefined();
    expect(sep.warnings.some((w) => w.includes("card_guard_date_mismatch"))).toBe(false);
  });

  it("再入職：舊 leave_date 3/31 未清、第二段 9/15 起——10 月出糧（唔再跳過），workDays 正確，病假年假以 0 開局；9 月（生效前）照舊跳過但有 rehire_suspected 警告", async () => {
    const b = await base();
    const g1 = await guard("測試再入職", D(1, 1, 2020), D(3, 31));
    await contract(b, g1.id, D(1, 1, 2020), D(3, 31));
    await contract(b, g1.id, D(9, 15));
    await mg(g1.id, "MG90611", { status: "former", validFrom: D(1, 1, 2020), validTo: D(3, 31), endReason: "resigned" });
    await mg(g1.id, "MG90612", { validFrom: D(9, 15) });
    // 上一段聘用留低嘅結餘（asOf 3 月，已放病假 4 日／年假 3 日）
    await prisma.guardLeaveBalance.create({ data: { guardId: g1.id, year: 2026, slAccrued: 10, slTaken: 4, alTaken: 3, asOfMonth: D(3, 1), alTakenOpening: 3, slTakenOpening: 4 } });
    await shifts(b, g1.id, 10, 1, 20);
    await shifts(b, g1.id, 9, 15, 20);
    const oct = await buildLongtermPayrollInputs(OCT);
    const line = oct.lines.find((l) => l.guardId === g1.id)!;
    expect(line).toBeDefined(); // 以前整行跳過
    expect(line.workDays).toBe(20);
    expect(line.netBasic).toBe(15500);
    expect(line.leaveBalanceWriteback).toMatchObject({ slOpeningUsed: 0, alOpeningUsed: 0 });
    expect(line.notes.some((n) => n.includes("再入職新聘用段"))).toBe(true);
    expect(oct.warnings.some((w) => w.includes("[rehire_detected]") && w.includes(g1.id))).toBe(true);
    // 9 月（生效前）：舊邏輯——employStart 9/15 > employEnd(leave 3/31) → 跳過；只加警告，唔改數字
    const sep = await buildLongtermPayrollInputs(SEP);
    expect(sep.lines.find((l) => l.guardId === g1.id)).toBeUndefined();
    expect(sep.warnings.some((w) => w.includes("[rehire_suspected]") && w.includes(g1.id))).toBe(true);
  });
});
