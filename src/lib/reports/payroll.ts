// 糧明細——由 DB 逐結算單位（雞頭/broker）重出。
// P1-WP4：由 scripts/report/payroll.ts 搬入呢度（單一 source of truth，
// scripts/report/payroll.ts 而家係 thin wrapper；`GET /api/reports/payroll`
// 用返同一份邏輯）。
//
// 注：P0 嘅 out/wp3/reports/payroll/雞頭糧明細-regenerated.xlsx 仲拆到
// 逐頁（settlement_page，例：某雞頭-1331 / 某雞頭-LINK / 總表確認-K…）咁細粒度，
// 反映原始紙本糧單嘅頁面邊界。WP1 呢度以 broker 為單位（粗一級），
// 逐 broker 總額對得起 P0 逐頁總額之和（見 WP1 回報「已知落差」，
// 精確逐頁重現留返規劃 session 決定是否需要）。
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2 } from "./money";

export const DEFAULT_REPORT_MONTH = new Date(Date.UTC(2026, 6, 1));
function monthRange(month: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { start, end };
}

export type BrokerPayrollTotal = { brokerId: string; brokerName: string; brokerCode: string; shifts: number; wage: number; fee: number; amount: number };

export async function buildPayrollTotals(month: Date = DEFAULT_REPORT_MONTH): Promise<BrokerPayrollTotal[]> {
  const { start, end } = monthRange(month);
  const brokers = await prisma.broker.findMany({ orderBy: { code: "asc" } });
  const out: BrokerPayrollTotal[] = [];
  for (const b of brokers) {
    const agg = await prisma.shiftRecord.aggregate({
      where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end } },
      _count: { _all: true },
      _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
    });
    const wage = round2(n(agg._sum.guardWageSnapshot));
    const fee = round2(n(agg._sum.brokerFeeSnapshot));
    if (agg._count._all === 0 && wage === 0 && fee === 0) continue;
    out.push({
      brokerId: b.id,
      brokerName: b.name,
      brokerCode: b.code,
      shifts: agg._count._all,
      wage,
      fee,
      amount: round2(wage + fee),
    });
  }
  return out;
}

export async function writePayrollXlsx(outPath: string, month: Date = DEFAULT_REPORT_MONTH) {
  const { start, end } = monthRange(month);
  const totals = await buildPayrollTotals(month);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("糧明細總表(按雞頭)");
  ws.addRow(["結算單位(雞頭)", "代號", "更數", "工資", "雞頭費", "金額"]);
  for (const t of totals) {
    ws.addRow([t.brokerName, t.brokerCode, t.shifts, t.wage, t.fee, t.amount]);
  }
  ws.addRow([
    "Total",
    "",
    totals.reduce((a, t) => a + t.shifts, 0),
    round2(totals.reduce((a, t) => a + t.wage, 0)),
    round2(totals.reduce((a, t) => a + t.fee, 0)),
    round2(totals.reduce((a, t) => a + t.amount, 0)),
  ]);

  // 逐安員明細（每個 broker 一個 sheet），方便人手覆核
  const brokers = await prisma.broker.findMany();
  for (const b of brokers) {
    const records = await prisma.shiftRecord.findMany({
      where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end } },
      include: { guard: true },
    });
    if (records.length === 0) continue;
    const byGuard = new Map<string, { name: string; staffNo: string; shifts: number; amount: number }>();
    for (const r of records) {
      const key = r.guardId;
      if (!byGuard.has(key)) {
        byGuard.set(key, { name: r.guard.nameZh, staffNo: r.guard.staffNo ?? "", shifts: 0, amount: 0 });
      }
      const g = byGuard.get(key)!;
      g.shifts++;
      g.amount = round2(g.amount + n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot));
    }
    const safeName = b.name.replace(/[\\/:*?"<>|[\]]/g, "_").slice(0, 28);
    const sheet = wb.addWorksheet(`${b.code || "?"}-${safeName}`);
    sheet.addRow(["Staff No.", "姓名", "更數", "金額"]);
    for (const g of byGuard.values()) sheet.addRow([g.staffNo, g.name, g.shifts, g.amount]);
  }

  await wb.xlsx.writeFile(outPath);
  return totals;
}
