// P1-WP4 §6.2／§4 WP4 item 4：雞頭「本月應收」——更數 × 自己出街價，逐日
// 明細＋合計。「出街價」= payout_rate（guard_wage + broker_fee），唔係
// client_rate（硬性規則1：雞頭連 view 都冇 client_rate）。
import { prisma } from "@/lib/db";
import { n, round2, monthRange as sharedMonthRange, monthLabel } from "./money";

export type MyReceivableDayRow = {
  workDate: string;
  siteId: string;
  siteName: string;
  shiftTypeCode: string;
  amount: number;
};

export type MyReceivableResult = {
  month: string;
  brokerId: string;
  days: MyReceivableDayRow[];
  total: number;
  totalShifts: number;
};

export async function buildMyReceivable(brokerId: string, month: Date): Promise<MyReceivableResult> {
  const { start, end } = sharedMonthRange(month);
  const records = await prisma.shiftRecord.findMany({
    where: {
      settlementBrokerId: brokerId,
      recordType: { in: ["shift", "ot"] },
      workDate: { gte: start, lte: end },
    },
    include: { site: { select: { id: true, canonicalName: true } }, shiftType: { select: { code: true } } },
    orderBy: [{ workDate: "asc" }],
  });

  const days: MyReceivableDayRow[] = records.map((r) => ({
    workDate: r.workDate.toISOString().slice(0, 10),
    siteId: r.siteId,
    siteName: r.site.canonicalName,
    shiftTypeCode: r.shiftType.code,
    amount: round2(n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot)),
  }));

  return {
    month: monthLabel(month),
    brokerId,
    days,
    total: round2(days.reduce((a, d) => a + d.amount, 0)),
    totalShifts: days.length,
  };
}
