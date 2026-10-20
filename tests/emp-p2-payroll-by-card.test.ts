// EMP-P2 第 3 部分：糧按工號卡分組＋逐人糧單。聚合 key 永遠含工號卡 id；同人兩卡兩行、總額＝兩行和；
// 改一張卡嘅薪率只影響該行；null 歸「未標工號」；MG 行 note＋長工糧；buildPayrollTotals 總數不變；雞頭唔睇逐人糧單。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { mkBroker, mkGuard } from "./lib/one-click-auto";
import { buildPayrollByCard, cardKey, schemeSubtotalsByBroker } from "@/lib/reports/payroll-by-card";
import { buildPayslips, LONGTERM_NOTE } from "@/lib/reports/payslips";
import { buildPayrollTotals, writePayrollBuffer } from "@/lib/reports/payroll";
import { GET as payrollGet } from "@/app/api/reports/payroll/route";

const d = (day: number) => new Date(Date.UTC(2026, 7, day));
const AUG = new Date(Date.UTC(2026, 7, 1));
const get = (cookie: string, qs: string) => payrollGet(new Request(`http://test.local/api/reports/payroll?${qs}`, { headers: { cookie } }));

describe("EMP-P2 糧按工號卡分組＋逐人糧單", () => {
  let fx: Wp2Fixture;
  let cardU: { id: string };
  let cardMP: { id: string };
  let shiftTypeId: string;
  let siteId: string;
  let day = 0;

  const rec = (guardId: string, over: { cardId?: string | null; scheme?: string | null; brokerId?: string | null; wage?: number; fee?: number; attrOnly?: boolean } = {}) => {
    day += 1;
    return prisma.shiftRecord.create({
      data: {
        workDate: d(day), siteId, shiftTypeId, guardId, recordType: "shift", status: "confirmed",
        settlementBrokerId: over.brokerId === undefined ? fx.brokerA.id : over.brokerId, operationalBrokerId: fx.brokerA.id,
        guardWageSnapshot: over.wage ?? 100, brokerFeeSnapshot: over.fee ?? 10, clientRateSnapshot: 300,
        ...(over.attrOnly ? {} : { staffNumberId: over.cardId ?? null, staffScheme: over.scheme ?? null }), createdBy: "t",
      },
    });
  };

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.shiftRecord.deleteMany({});
    siteId = fx.site.id;
    shiftTypeId = fx.shiftType.id;
    day = 0;
    cardU = await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "U", number: "U90901", status: "current" } });
    cardMP = await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "MP", number: "MP90901", status: "current" } });
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { staffNo: "U90901" } });
    // 還原出廠 staff_schemes（其他測試可能改過）
    await prisma.staffScheme.upsert({ where: { code: "U" }, update: { payerLabelZh: "Wilson 出糧" }, create: { code: "U", labelZh: "U（Wilson 盤）", payerCode: "wilson", payerLabelZh: "Wilson 出糧", sort: 1 } });
    await prisma.staffScheme.upsert({ where: { code: "MP" }, update: { payerLabelZh: "在勤出糧" }, create: { code: "MP", labelZh: "MP（在勤盤）", payerCode: "maxwell", payerLabelZh: "在勤出糧", sort: 2 } });
  });

  it("聚合 key 永遠含工號卡 id；同人 MP＋U 兩張卡 → 兩行分開（唔撈埋），冇歸屬 → 「未標工號」另一行", async () => {
    await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 200, fee: 20 });
    await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 200, fee: 20 });
    await rec(fx.guardA.id, { cardId: cardMP.id, scheme: "MP", wage: 150, fee: 15 });
    await rec(fx.guardA.id, { cardId: null, wage: 50, fee: 5 });
    const rows = await buildPayrollByCard(AUG);
    expect(rows.map((r) => r.key).sort()).toEqual([cardKey(fx.guardA.id, cardU.id), cardKey(fx.guardA.id, cardMP.id), cardKey(fx.guardA.id, null)].sort());
    expect(cardKey(fx.guardA.id, null)).toBe(`${fx.guardA.id}|none`);
    const u = rows.find((r) => r.staffNumberId === cardU.id)!;
    expect(u).toMatchObject({ scheme: "U", number: "U90901", shifts: 2, wage: 400, fee: 40, amount: 440 });
    const slips = await buildPayslips(AUG);
    expect(slips).toHaveLength(1);
    const p = slips[0]!;
    expect(p.lines.map((l) => [l.scheme, l.number, l.amount, l.fee])).toEqual([["U", "U90901", 400, 40], ["MP", "MP90901", 150, 15], [null, null, 50, 5]]); // U→MP→未標；個人金額＝工資（唔含雞頭費），雞頭費另欄
    expect(p.lines[0]).toMatchObject({ payerLabel: "Wilson 出糧", schemeLabel: expect.stringContaining("U") });
    expect(p.lines[1]).toMatchObject({ payerLabel: "在勤出糧" });
    expect(p.lines[2]).toMatchObject({ schemeLabel: "未標工號", staffNumberId: null });
    expect(p.total).toBe(600); // 各行個人金額（工資）之和，唔含雞頭費
    expect(p.feeTotal).toBe(60);
    expect(p.longtermTotal).toBeNull();
    expect(p.total).toBe(p.lines.reduce((s, l) => s + l.amount, 0));
  });

  it("M2（Opus 個案）：U 3 更每更工資 500＋MP 2 更每更 620 → U 行 1500、MP 行 1240、散更 total 2740；雞頭費欄 120／60 唔入 total", async () => {
    for (let i = 0; i < 3; i++) await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 500, fee: 40 });
    for (let i = 0; i < 2; i++) await rec(fx.guardA.id, { cardId: cardMP.id, scheme: "MP", wage: 620, fee: 30 });
    const p = (await buildPayslips(AUG))[0]!;
    expect(p.lines.map((l) => [l.scheme, l.shifts, l.amount, l.wage, l.fee])).toEqual([["U", 3, 1500, 1500, 120], ["MP", 2, 1240, 1240, 60]]);
    expect(p.total).toBe(2740);
    expect(p.feeTotal).toBe(180);
    // buildPayrollTotals（按雞頭）仍然係工資＋雞頭費（雞頭角度），唔受影響
    const t = (await buildPayrollTotals(AUG)).find((x) => x.brokerId === fx.brokerA.id)!;
    expect(t).toMatchObject({ wage: 2740, fee: 180, amount: 2920 });
  });

  it("改一張卡嘅薪率只影響該行（另一張卡嘅行不變）", async () => {
    const a = await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 200, fee: 20 });
    await rec(fx.guardA.id, { cardId: cardMP.id, scheme: "MP", wage: 150, fee: 15 });
    const before = (await buildPayslips(AUG))[0]!;
    await prisma.shiftRecord.update({ where: { id: a.id }, data: { guardWageSnapshot: 999 } });
    // 報表 memo 只喺 request context 內，直接再 call 即重算
    const after = (await buildPayslips(AUG))[0]!;
    expect(after.lines.find((l) => l.scheme === "MP")).toEqual(before.lines.find((l) => l.scheme === "MP"));
    expect(after.lines.find((l) => l.scheme === "U")!.wage).toBe(999);
    expect(after.total).toBe(999 + 150);
  });

  it("buildPayrollTotals 總數不變；by_scheme 小計加埋＝該雞頭總數；已鎖月只有側表歸屬都歸返卡", async () => {
    const r1 = await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 200, fee: 20 });
    await rec(fx.guardA.id, { cardId: cardMP.id, scheme: "MP", wage: 150, fee: 15 });
    await rec(fx.guardA.id, { cardId: null, wage: 50, fee: 5 });
    const r4 = await rec(fx.guardA.id, { attrOnly: true, wage: 70, fee: 7 }); // shift_records 冇歸屬，側表有（鎖月回填）
    await prisma.shiftRecordStaffAttribution.create({ data: { shiftRecordId: r4.id, staffNumberId: cardMP.id, staffScheme: "MP", source: "backfill:range" } });
    void r1;
    const totals = await buildPayrollTotals(AUG);
    const t = totals.find((x) => x.brokerId === fx.brokerA.id)!;
    expect(t).toMatchObject({ shifts: 4, wage: 470, fee: 47, amount: 517 }); // 同舊算法一致
    expect(t.by_scheme.map((s) => [s.scheme, s.shifts, s.amount])).toEqual([["MP", 2, 242], ["U", 1, 220], [null, 1, 55]]);
    expect(t.by_scheme.reduce((s, x) => s + x.amount, 0)).toBe(t.amount);
    const rows = await buildPayrollByCard(AUG);
    expect(rows.find((r) => r.staffNumberId === cardMP.id)!.shifts).toBe(2); // 側表歸屬併入 MP 卡
    expect(schemeSubtotalsByBroker(rows).get(fx.brokerA.id)!.length).toBe(3);
  });

  it("MG（長工）行：金額由長工糧表 line 取，標 note「見長工糧表」；攞唔到就 0＋note；排 MP 之後", async () => {
    const B07 = await mkBroker("SB07P2", "internal_longterm");
    const g = await mkGuard({ employmentType: "longterm_autopay" });
    const mg = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG90901", status: "current" } });
    const mp = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MP", number: "MP90902", status: "current" } });
    await rec(g.id, { cardId: mg.id, scheme: "MG", brokerId: B07.id, wage: 0, fee: 0 });
    await rec(g.id, { cardId: mp.id, scheme: "MP", wage: 300, fee: 0 });
    // 未有長工糧 line → 0＋note
    let slip = (await buildPayslips(AUG)).find((p) => p.guardId === g.id)!;
    expect(slip.lines.map((l) => l.scheme)).toEqual(["MP", "MG"]);
    expect(slip.lines[1]).toMatchObject({ amount: 0 });
    expect(slip.lines[1]!.note).toContain(LONGTERM_NOTE);
    // 有長工糧 line
    const run = await prisma.longtermPayrollRun.create({ data: { month: AUG, status: "confirmed" } });
    await prisma.longtermPayrollLine.create({ data: { runId: run.id, guardId: g.id, contractSnapshot: [], daysInMonth: 31, netBasic: 12000, gross: 12500, autopay: 11900 } });
    slip = (await buildPayslips(AUG)).find((p) => p.guardId === g.id)!;
    expect(slip.lines[1]).toMatchObject({ scheme: "MG", amount: 12500, note: LONGTERM_NOTE, payerLabel: "在勤長工糧", payMethod: "autopay" });
    expect(slip.lines[0]).toMatchObject({ scheme: "MP", amount: 300, isLongterm: false });
    expect(slip.lines[1]!.isLongterm).toBe(true);
    // M2：長工毛額另行獨立小計，唔併入散更 total
    expect(slip.total).toBe(300);
    expect(slip.longtermTotal).toBe(12500);
    // 有長工糧但冇任何 MG 更次 → 補 MG 行
    const g2 = await mkGuard({ employmentType: "longterm_autopay" });
    await prisma.guardStaffNumber.create({ data: { guardId: g2.id, scheme: "MG", number: "MG90903", status: "current" } });
    await prisma.longtermPayrollLine.create({ data: { runId: run.id, guardId: g2.id, contractSnapshot: [], daysInMonth: 31, netBasic: 9000, gross: 9100, autopay: 8600 } });
    const s2 = (await buildPayslips(AUG)).find((p) => p.guardId === g2.id)!;
    expect(s2.lines).toHaveLength(1);
    expect(s2.lines[0]).toMatchObject({ scheme: "MG", number: "MG90903", shifts: 0, amount: 9100 });
  });

  it("Excel：舊 sheet 次序不變、逐人糧單 sheet 加喺最後；雞頭 sheet 每人每卡一行（工號欄印該卡號；未標工號印 guards.staff_no＋標記）", async () => {
    await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U", wage: 200, fee: 20 });
    await rec(fx.guardA.id, { cardId: cardMP.id, scheme: "MP", wage: 150, fee: 15 });
    await rec(fx.guardA.id, { cardId: null, wage: 50, fee: 5 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await writePayrollBuffer(AUG)) as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe("糧明細總表(按雞頭)");
    expect(names.slice(-3)).toEqual(["來源摘要", "逐更來源明細", "逐人糧單"]);
    const broker = wb.worksheets.find((w) => w.name.startsWith(`${fx.brokerA.name ? "" : ""}`) && w.name !== names[0] && !["來源摘要", "逐更來源明細", "逐人糧單"].includes(w.name))!;
    const rows: unknown[][] = [];
    broker.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    expect(rows[0]).toEqual(["Staff No.", "姓名", "體系", "更數", "金額"]);
    const body = rows.slice(1).map((r) => [r[0], r[2], r[3], r[4]]);
    expect(body).toContainEqual(["U90901", "U", 1, 220]);
    expect(body).toContainEqual(["MP90901", "MP", 1, 165]);
    expect(body).toContainEqual(["U90901", "未標工號", 1, 55]); // 未標：印 guards.staff_no＋標記
    const slip = wb.getWorksheet("逐人糧單")!;
    const slipRows: unknown[][] = [];
    slip.eachRow((r) => slipRows.push((r.values as unknown[]).slice(1)));
    const sub = slipRows.find((r) => String(r[1]).startsWith("小計"))!;
    expect(sub[5]).toBe(400); // 散更個人金額小計（工資，唔含雞頭費）
    expect(sub[6]).toBe(40); // 雞頭費小計（資料欄）
    // 新欄位次序
    expect(slipRows[0]).toEqual(["逐人糧單（個人金額唔含雞頭費；長工毛額另行小計，見長工糧表）"]);
    expect(slipRows[1]).toEqual(["Staff No.", "姓名／體系", "出糧方", "結算單位", "更數", "個人金額（工資，唔含雞頭費）", "雞頭費（唔入個人金額）", "備註"]);
  });

  it("API：?view=person 老闆 200；雞頭 403（跨雞頭）；舊 totals 回應仍有 by_scheme", async () => {
    await rec(fx.guardA.id, { cardId: cardU.id, scheme: "U" });
    const boss = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await get(boss, "month=2026-08&view=person");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payslips[0].lines[0]).toMatchObject({ scheme: "U", settlement_broker_code: expect.any(String) });
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await get(broker, "month=2026-08&view=person")).status).toBe(403);
    const totals = await (await get(boss, "month=2026-08")).json();
    expect(totals.totals[0].by_scheme[0]).toMatchObject({ scheme: "U", shifts: 1 });
  });
});
