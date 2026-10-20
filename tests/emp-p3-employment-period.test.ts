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
    expect(p.warnings).toEqual([{ code: "rehire_detected", guardId: "G1", basis: "chain", cardDate: "2026-09-15", guardDate: "2026-03-31" }]);
    // M2（EMP-P3.1）：人卡 leave_date 已被鏡像清走（null）都照樣由卡鏈判斷到再入職
    const cleared = resolveLongtermPeriod(g(D(1, 1, 2020), null), [first, second], OCT);
    expect([cleared.rehire, iso(cleared.start), cleared.end, cleared.warnings.map((w) => w.basis)]).toEqual([true, "2026-09-15", null, ["chain"]]);
    // 只靠人卡舊離職日（冇更早卡鏈）＝fallback 判斷，basis=guard_leave
    const fb = resolveLongtermPeriod(g(D(1, 1, 2020), D(3, 31)), [second], OCT);
    expect([fb.rehire, fb.warnings.map((w) => w.basis)]).toEqual([true, ["guard_leave"]]);
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

});

describe("resolveLongtermPeriod 專用警告（EMP-P3.1 S1／S2）", () => {
  it("S1 同月兩段聘用：舊段 resigned 同新段起點都喺本月 → two_segments_in_month（舊段未計）", () => {
    const a = card("a", { status: "former", validFrom: D(1, 1, 2020), validTo: D(10, 10), endReason: "resigned" });
    const b = card("b", { validFrom: D(10, 20) });
    const p = resolveLongtermPeriod(g(null, null), [a, b], OCT);
    expect(p.warnings.map((w) => w.code)).toEqual(["rehire_detected", "two_segments_in_month"]);
    expect(p.warnings[1]).toMatchObject({ cardDate: "2026-10-20", guardDate: "2026-10-10" });
    expect(iso(p.start)).toBe("2026-10-20");
  });
  it("S2 選中鏈起點遲過月尾 → segment_starts_after_month", () => {
    const p = resolveLongtermPeriod(g(null, null), [card("a", { validFrom: D(11, 5) })], OCT);
    expect(p.warnings.map((w) => w.code)).toEqual(["segment_starts_after_month"]);
  });
});

describe("對拍腳本 longterm-card-dates-diff（只讀）", () => {
  it("逐個長工分類：一致／卡冇日期／唔一致／疑似再入職／冇 MG 卡；只讀唔寫；rows 只有 guardId 同日期", async () => {
    const { diffLongtermCardDates } = await import("../scripts/db/longterm-card-dates-diff");
    const b = await base();
    const mkG = async (name: string, hire: Date | null, leave: Date | null = null) => {
      const x = await guard(name, hire, leave);
      await contract(b, x.id, D(1, 1, 2020));
      return x;
    };
    const same = await mkG("測試一致", D(1, 1, 2025));
    await mg(same.id, "MG90701", { validFrom: D(1, 1, 2025) });
    const nodates = await mkG("測試無日期", D(2, 2, 2025));
    await mg(nodates.id, "MG90702");
    const mism = await mkG("測試唔一致", D(3, 3, 2025));
    await mg(mism.id, "MG90703", { validFrom: D(3, 5, 2025) });
    const rehire = await mkG("測試再入職", D(1, 1, 2020), D(3, 31));
    await mg(rehire.id, "MG90704", { status: "former", validFrom: D(1, 1, 2020), validTo: D(3, 31), endReason: "resigned" });
    await mg(rehire.id, "MG90705", { validFrom: D(9, 15) });
    const nocard = await mkG("測試無卡", D(5, 5, 2025));
    const late = await mkG("測試遲起點", D(11, 5));
    await mg(late.id, "MG90706", { validFrom: D(11, 5) });
    const before = await prisma.guard.findMany({ orderBy: { id: "asc" }, select: { id: true, hireDate: true, leaveDate: true } });
    const out = await diffLongtermCardDates(D(11, 1));
    const k = (id: string) => out.rows.find((r) => r.guard_id === id)!.klass;
    expect([k(same.id), k(nodates.id), k(mism.id), k(rehire.id), k(nocard.id), k(late.id)]).toEqual(["consistent", "card_no_dates", "mismatch", "rehire_suspected", "no_mg_card", "consistent"]);
    expect(out.counts).toEqual({ consistent: 2, card_no_dates: 1, mismatch: 1, rehire_suspected: 1, no_mg_card: 1 });
    // EMP-P3.1 S4：兩類獨立清單，各列 guardId 同前後日期
    expect(out.start_after_effective).toEqual([{ guard_id: late.id, card_start: "2026-11-05", effective_from: "2026-10-01" }]);
    expect(out.mirror_would_change.map((r) => r.guard_id).sort()).toEqual([mism.id, rehire.id].sort());
    expect(out.mirror_would_change.find((r) => r.guard_id === mism.id)).toMatchObject({ hire_before: "2025-03-03", hire_after: "2025-03-05" });
    expect(out.mirror_would_change.find((r) => r.guard_id === rehire.id)).toMatchObject({ leave_before: "2026-03-31", leave_after: null, hints: ["stale_leave_date_cleared"] });
    expect(Object.keys(out.rows[0]!).sort()).toEqual(["card_end", "card_start", "chain_card_ids", "guard_hire", "guard_id", "guard_leave", "klass"]);
    expect(await prisma.guard.findMany({ orderBy: { id: "asc" }, select: { id: true, hireDate: true, leaveDate: true } })).toEqual(before); // 只讀
  });
});

describe("對拍腳本 P3.2：resigned_without_valid_to", () => {
  it("former＋resigned 但冇 valid_to 嘅卡列出 guardId＋cardId；有 valid_to 或 replaced 唔列", async () => {
    const { diffLongtermCardDates } = await import("../scripts/db/longterm-card-dates-diff");
    const b = await base();
    const x = await guard("測試舊資料", D(1, 1, 2023));
    await contract(b, x.id, D(1, 1, 2023));
    const bad = await mg(x.id, "MG90711", { status: "former", validFrom: D(1, 1, 2023), endReason: "resigned" });
    await mg(x.id, "MG90712", { status: "former", validFrom: D(1, 1, 2024), validTo: D(2, 2, 2024), endReason: "resigned" });
    await mg(x.id, "MG90713", { status: "former", validFrom: D(3, 3, 2024), endReason: "replaced" });
    const out = await diffLongtermCardDates(D(11, 1));
    expect(out.resigned_without_valid_to).toEqual([{ guard_id: x.id, card_id: (bad as { id: string }).id }]);
  });
});
