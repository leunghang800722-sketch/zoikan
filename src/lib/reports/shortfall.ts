// P1-WP4 §6.1 第 1 項／§3c：尚欠總覽——今日／本月各盤 confirmed vs
// daily_requirements，尚欠標紅；待審批數；本月毛利進度。
import { prisma } from "@/lib/db";
import { monthRange as sharedMonthRange, monthStart, monthLabel } from "./money";
import { buildGrossMargin, DEFAULT_MARGIN_THRESHOLD_PCT } from "./gross-margin";

export type ShortfallSiteRow = {
  siteId: string;
  siteName: string;
  required: number;
  confirmed: number;
  shortfall: number; // required - confirmed，>0 標紅
};

export type ShortfallResult = {
  date: string;
  today: ShortfallSiteRow[];
  pendingApprovalCount: number;
  monthProgress: {
    month: string;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number | null;
    thresholdPct: number;
    belowThresholdSiteCount: number;
  };
};

/** 今日（或指定日期）逐盤所需人手 vs confirmed 更次——daily_requirements
 * 冇 override 就跌返用 shift_types.headcount_required（設計 §3.2 daily_
 * requirements「每日所需人手 override」，冇 override 用更別本身嘅預設）。 */
export async function buildShortfall(date: Date): Promise<ShortfallResult> {
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const month = monthStart(dayStart);
  const { start: MONTH_START, end: MONTH_END } = sharedMonthRange(month);

  const sites = await prisma.site.findMany({ where: { inScope: true, status: "active" }, orderBy: { canonicalName: "asc" } });
  const shiftTypes = await prisma.shiftType.findMany({ where: { siteId: { in: sites.map((s) => s.id) }, voidedAt: null } });
  const dailyReqs = await prisma.dailyRequirement.findMany({ where: { workDate: dayStart, voidedAt: null } });
  const reqBySiteShiftType = new Map(dailyReqs.map((r) => [`${r.siteId}|${r.shiftTypeId}`, r.headcountRequired]));

  const confirmedToday = await prisma.shiftRecord.groupBy({
    by: ["siteId"],
    where: { workDate: dayStart, recordType: "shift", status: { in: ["confirmed", "completed"] }, isExternal: false },
    _count: { _all: true },
  });
  const confirmedBySite = new Map(confirmedToday.map((r) => [r.siteId, r._count._all]));

  const today: ShortfallSiteRow[] = [];
  for (const site of sites) {
    const siteShiftTypes = shiftTypes.filter((st) => st.siteId === site.id && st.billingGroup === "per_shift");
    let required = 0;
    for (const st of siteShiftTypes) {
      const override = reqBySiteShiftType.get(`${site.id}|${st.id}`);
      required += override ?? st.headcountRequired ?? 0;
    }
    const confirmed = confirmedBySite.get(site.id) ?? 0;
    if (required === 0 && confirmed === 0) continue; // 冇任何所需人手都冇出勤嘅盤唔顯示，減噪音
    today.push({ siteId: site.id, siteName: site.canonicalName, required, confirmed, shortfall: required - confirmed });
  }

  const pendingApprovalCount = await prisma.shiftRecord.count({
    where: { status: "pending_approval", workDate: { gte: MONTH_START, lte: MONTH_END } },
  });

  const margin = await buildGrossMargin(month);
  const belowThresholdSiteCount = margin.sites.filter((s) => s.belowThreshold).length;

  return {
    date: dayStart.toISOString().slice(0, 10),
    today: today.sort((a, b) => b.shortfall - a.shortfall),
    pendingApprovalCount,
    monthProgress: {
      month: monthLabel(month),
      revenue: margin.totals.revenue,
      cost: margin.totals.cost,
      profit: margin.totals.profit,
      marginPct: margin.totals.marginPct,
      thresholdPct: margin.thresholdPct ?? DEFAULT_MARGIN_THRESHOLD_PCT,
      belowThresholdSiteCount,
    },
  };
}
