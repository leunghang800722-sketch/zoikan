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
    select: { siteId: true, shiftTypeId: true, status: true, site: { select: { canonicalName: true } } },
  });

  const bySite = new Map<string, { siteName: string; shifts: number; pending: number }>();
  for (const r of records) {
    const cur = bySite.get(r.siteId) ?? { siteName: r.site.canonicalName, shifts: 0, pending: 0 };
    cur.shifts += 1;
    if (r.status === "pending_approval") cur.pending += 1;
    bySite.set(r.siteId, cur);
  }

  // B7 驗收修正：「我有份嘅盤」原本淨係靠「本月有 settlement 更次」判斷，
  // 漏咗「有 assignment 但呢個月未開過更」嘅盤（例如岩指派咗、雞頭仲未
  // 落更表填人）——跟 `broker-isolation.ts` `scopeSiteWhere()`／
  // `assertSiteAssignedToBroker()` 嘅歸屬口徑：`broker_site_assignments`
  // （該月）先係「有冇份」嘅真正依據，唔可以淨係睇「有冇更次」反推。
  // 呢度將該月 assignment 嘅盤同上面已經有更次嘅盤做聯集——淨係得
  // assignment、未開更嘅盤更數維持 0（唔會喺 bySite 出現就補一行 0）。
  const assignments = await prisma.brokerSiteAssignment.findMany({
    where: { brokerId, month: m },
    select: { siteId: true, site: { select: { canonicalName: true } } },
  });
  for (const a of assignments) {
    if (!bySite.has(a.siteId)) {
      bySite.set(a.siteId, { siteName: a.site.canonicalName, shifts: 0, pending: 0 });
    }
  }

  const sites: BrokerDashboardSiteRow[] = Array.from(bySite.entries())
    .map(([siteId, v]) => ({ siteId, siteName: v.siteName, shifts: v.shifts, pending: v.pending }))
    .sort((a, b) => b.shifts - a.shifts);

  const guardCount = await prisma.guard.count({ where: { defaultBrokerId: brokerId, status: "active" } });

  // B9 驗收修正：配額 KPI 口徑——分子（scheduledShifts）原本用
  // `records.length`（呢個雞頭*全部*盤嘅已排更數），呢個係錯嘅：配額係
  // 逐「(盤,更別)」組合設嘅軟性限制，分子應該只計「有設配額嗰啲
  // (site_id, shift_type_id) 組合」嘅已排更數，其他冇配額嘅盤/更別唔應該
  // 計落個「已排」度（否則個分子會大過分母對應嘅範圍，數口徑對唔上）；
  // 分母＝該月呢個雞頭全部配額 target_shifts 加總。完全冇任何配額行先
  // 顯示「未設」（quota=null）。
  const quotas = await prisma.quota.findMany({ where: { brokerId, month: m, voidedAt: null } });
  let quota: { targetShifts: number; scheduledShifts: number } | null = null;
  if (quotas.length > 0) {
    const quotaKeys = new Set(quotas.map((q) => `${q.siteId}|${q.shiftTypeId}`));
    const scheduledShifts = records.filter((r) => quotaKeys.has(`${r.siteId}|${r.shiftTypeId}`)).length;
    const targetShifts = quotas.reduce((a, q) => a + q.targetShifts, 0);
    quota = { targetShifts, scheduledShifts };
  }

  return {
    month: monthLabel(m),
    scheduledShifts: records.length,
    pendingApprovalCount: records.filter((r) => r.status === "pending_approval").length,
    guardCount,
    quota,
    sites,
  };
}
