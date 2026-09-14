// P2-B：更表索引「最近開過」列表（README §03）——用「該月有 shift_
// records 或 broker_site_assignments 嘅盤」代替真正嘅瀏覽歷史（唔加新
// 表，見 P2-版面重設計計劃.md §5 判斷）。每行：盤名／人數（distinct
// guard）／更數（record_type=shift）／locked（month_closes）／shortfall
// （該月 daily_requirements − confirmed 嘅正差總和，簡化做法，唔限
// 「至今」）。
//
// 雞頭隔離：用現有 scopeShiftRecordWhere()／scopeBrokerSiteAssignmentWhere()
// ——雞頭 session 淨係見到自己有份（broker_site_assignments 白名單）嘅
// 盤，人數／更數淨係計自己嘅（settlement_broker_id 或 operational_broker_id
// = 自己）。shortfall 係盤級整體尚欠（daily_requirements 冇拆返邊個
// broker），唔含任何其他 broker 嘅個別資料，雞頭見到唔算隔離漏洞。
import { prisma } from "@/lib/db";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { scopeShiftRecordWhere, scopeBrokerSiteAssignmentWhere } from "@/lib/broker-isolation";
import { monthRange, monthStart } from "./money";

export type RosterOverviewSiteRow = {
  siteId: string;
  siteName: string;
  guardCount: number;
  shiftCount: number;
  locked: boolean;
  shortfall: number;
};

export type RosterOverviewResult = {
  month: string;
  sites: RosterOverviewSiteRow[];
};

export async function buildRosterOverview(session: AuthedSession, month: Date): Promise<RosterOverviewResult> {
  const { start, end } = monthRange(month);

  // 1. 該月有 shift_records（record_type=shift）嘅盤（已按雞頭 scope）。
  const shiftSiteRows = await prisma.shiftRecord.findMany({
    where: scopeShiftRecordWhere(session, { workDate: { gte: start, lte: end }, recordType: "shift" }),
    select: { siteId: true },
    distinct: ["siteId"],
  });

  // 2. 該月有 broker_site_assignments 嘅盤（已按雞頭 scope）。
  const assignmentSiteRows = await prisma.brokerSiteAssignment.findMany({
    where: scopeBrokerSiteAssignmentWhere(session, { month: monthStart(month) }),
    select: { siteId: true },
    distinct: ["siteId"],
  });

  const siteIds = Array.from(new Set([...shiftSiteRows.map((r) => r.siteId), ...assignmentSiteRows.map((r) => r.siteId)]));
  if (siteIds.length === 0) return { month: month.toISOString().slice(0, 7), sites: [] };

  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } }, orderBy: { canonicalName: "asc" } });

  // 人數／更數——同一次 query 拎晒（已按雞頭 scope，雞頭見唔到其他
  // broker 嘅 guard/更次）。
  const records = await prisma.shiftRecord.findMany({
    where: scopeShiftRecordWhere(session, { siteId: { in: siteIds }, workDate: { gte: start, lte: end }, recordType: "shift" }),
    select: { siteId: true, guardId: true },
  });
  const guardSetBySite = new Map<string, Set<string>>();
  const shiftCountBySite = new Map<string, number>();
  for (const r of records) {
    shiftCountBySite.set(r.siteId, (shiftCountBySite.get(r.siteId) ?? 0) + 1);
    const set = guardSetBySite.get(r.siteId) ?? new Set<string>();
    set.add(r.guardId);
    guardSetBySite.set(r.siteId, set);
  }

  // 鎖定狀態——月結一個月一行，唔分盤。
  const monthClose = await prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { lockedAt: true } });
  const locked = !!monthClose?.lockedAt;

  // 尚欠——daily_requirements（headcount_required）vs confirmed 更次
  // 嘅正差總和（跟 buildShortfall() 同一條邏輯，呢度加埋成個月）。
  const dailyReqs = await prisma.dailyRequirement.findMany({
    where: { siteId: { in: siteIds }, workDate: { gte: start, lte: end }, voidedAt: null },
  });
  const confirmed = await prisma.shiftRecord.groupBy({
    by: ["siteId", "shiftTypeId", "workDate"],
    where: scopeShiftRecordWhere(session, {
      siteId: { in: siteIds },
      workDate: { gte: start, lte: end },
      recordType: "shift",
      status: { in: ["confirmed", "completed"] },
      isExternal: false,
    }),
    _count: { _all: true },
  });
  const confirmedMap = new Map(confirmed.map((c) => [`${c.siteId}|${c.shiftTypeId}|${c.workDate.toISOString()}`, c._count._all]));
  const shortfallBySite = new Map<string, number>();
  for (const dr of dailyReqs) {
    const key = `${dr.siteId}|${dr.shiftTypeId}|${dr.workDate.toISOString()}`;
    const confirmedCount = confirmedMap.get(key) ?? 0;
    const gap = Math.max(0, dr.headcountRequired - confirmedCount);
    if (gap > 0) shortfallBySite.set(dr.siteId, (shortfallBySite.get(dr.siteId) ?? 0) + gap);
  }

  return {
    month: month.toISOString().slice(0, 7),
    sites: sites.map((s) => ({
      siteId: s.id,
      siteName: s.canonicalName,
      guardCount: guardSetBySite.get(s.id)?.size ?? 0,
      shiftCount: shiftCountBySite.get(s.id) ?? 0,
      locked,
      shortfall: shortfallBySite.get(s.id) ?? 0,
    })),
  };
}
