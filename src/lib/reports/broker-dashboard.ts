// P2-WP-R3：雞頭首頁 dashboard（README §25／手機 §21）——本月已排更數／
// 待審批數／自己保安員數／配額狀態／「我有份嘅盤」逐盤明細。淨係
// SELECT（冇任何寫入），雞頭隔離靠成個查詢一律用 `brokerId` 收窄（同
// `buildMyReceivable()`／`assertGuardOwnedByBroker()` 一致嘅口徑：
// settlement_broker_id=自己 或 guard.default_broker_id=自己），冇任何
// query 參數可以指定第二個 broker_id（結構性排除「雞頭A想睇雞頭B」）。
import { prisma } from "@/lib/db";
import { monthRange, monthStart, monthLabel } from "./money";

export type BrokerDashboardSiteRow = {
  siteId: string;
  siteName: string;
  shifts: number;
  pending: number;
};

export type BrokerDashboardResult = {
  month: string;
  scheduledShifts: number;
  pendingApprovalCount: number;
  guardCount: number;
  /** null＝呢個月冇設任何配額（README「配額」KPI 顯示「未設」）。 */
  quota: { targetShifts: number; scheduledShifts: number } | null;
  sites: BrokerDashboardSiteRow[];
};

export async function buildBrokerDashboard(brokerId: string, month: Date): Promise<BrokerDashboardResult> {
  const m = monthStart(month);
  const { start, end } = monthRange(m);

  // 「本月已排更數」＝正更＋超時（唔計 leave；leave 本身冇「所需人手」
  // 概念），排除 cancelled（同 `/api/shift-records` 預設口徑一致）。
  const records = await prisma.shiftRecord.findMany({
    where: {
      settlementBrokerId: brokerId,
      recordType: { in: ["shift", "ot"] },
      status: { not: "cancelled" },
      workDate: { gte: start, lte: end },
    },
    select: { siteId: true, status: true, site: { select: { canonicalName: true } } },
  });

  const bySite = new Map<string, { siteName: string; shifts: number; pending: number }>();
  for (const r of records) {
    const cur = bySite.get(r.siteId) ?? { siteName: r.site.canonicalName, shifts: 0, pending: 0 };
    cur.shifts += 1;
    if (r.status === "pending_approval") cur.pending += 1;
    bySite.set(r.siteId, cur);
  }
  const sites: BrokerDashboardSiteRow[] = Array.from(bySite.entries())
    .map(([siteId, v]) => ({ siteId, siteName: v.siteName, shifts: v.shifts, pending: v.pending }))
    .sort((a, b) => b.shifts - a.shifts);

  const guardCount = await prisma.guard.count({ where: { defaultBrokerId: brokerId, status: "active" } });

  const quotas = await prisma.quota.findMany({ where: { brokerId, month: m, voidedAt: null } });
  const quota = quotas.length === 0 ? null : { targetShifts: quotas.reduce((a, q) => a + q.targetShifts, 0), scheduledShifts: records.length };

  return {
    month: monthLabel(m),
    scheduledShifts: records.length,
    pendingApprovalCount: records.filter((r) => r.status === "pending_approval").length,
    guardCount,
    quota,
    sites,
  };
}
