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

// P2-B M4（Opus 驗收）additive：按 (日期, 盤, 更別, 出街價) 合併嘅分組
// 行——表要顯示「更數 × 出街價 ＝ 金額」（例：12 × 700 = 8,400），唔准
// 每條 shift_record 一行。`outsideRate` = 呢組入面每更嘅出街價（分組
// key 本身已經含出街價，即係組入面逐更金額一定相等）。`days`（逐
// record）保持唔變，俾舊有 consumer／unit test 用；`groupedDays` 純粹
// additive，UI 改用呢個。
export type MyReceivableGroupRow = {
  workDate: string;
  siteId: string;
  siteName: string;
  shiftTypeCode: string;
  outsideRate: number;
  shifts: number;
  amount: number;
};

export type MyReceivableResult = {
  month: string;
  brokerId: string;
  days: MyReceivableDayRow[];
  groupedDays: MyReceivableGroupRow[];
  total: number;
  totalShifts: number;
  // P2-B（README §11 3 張 stat 卡第三張「待審批 N 更 · 金額」）：additive
  // 欄位——`days`／`total`／`totalShifts` 一律唔篩 status（跟原本口徑，
  // 包晒 draft/pending_approval/confirmed/completed），呢兩個欄淨係喺
  // 上面嗰堆入面再篩出 status=pending_approval 嘅子集，俾 UI 出橙色提示。
  pendingCount: number;
  pendingAmount: number;
};

function groupDays(days: MyReceivableDayRow[]): MyReceivableGroupRow[] {
  const map = new Map<string, MyReceivableGroupRow>();
  for (const d of days) {
    const key = `${d.workDate}|${d.siteId}|${d.shiftTypeCode}|${d.amount}`;
    const existing = map.get(key);
    if (existing) {
      existing.shifts += 1;
      existing.amount = round2(existing.amount + d.amount);
    } else {
      map.set(key, { workDate: d.workDate, siteId: d.siteId, siteName: d.siteName, shiftTypeCode: d.shiftTypeCode, outsideRate: d.amount, shifts: 1, amount: d.amount });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.workDate.localeCompare(b.workDate) || a.siteName.localeCompare(b.siteName) || a.shiftTypeCode.localeCompare(b.shiftTypeCode),
  );
}

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

  const pendingRecords = records.filter((r) => r.status === "pending_approval");
  const pendingAmount = round2(pendingRecords.reduce((a, r) => a + n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot), 0));

  return {
    month: monthLabel(month),
    brokerId,
    days,
    groupedDays: groupDays(days),
    total: round2(days.reduce((a, d) => a + d.amount, 0)),
    totalShifts: days.length,
    pendingCount: pendingRecords.length,
    pendingAmount,
  };
}
