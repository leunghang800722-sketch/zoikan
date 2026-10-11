// P10.2：長工「頂位更」認定（唯讀）。
// 定義（老闆確認）：長工喺**唔係自己固定崗位盤**嘅更＝頂位更。固定崗位盤＝`guard_longterm_posts`（當日生效、未作廢；母盤登記冚子盤，子盤登記唔冚母盤——同 `resolveLongtermSettlement` 一致）。
// 排除：簽證形式長工（visaSponsoredByBrokerId，永遠當雞頭散更）；當日冇任何崗位盤嘅長工（認定唔到「自己崗位」，只計數 `noPostShifts`）。
// 職級 grade：更表行 `rank_raw` 經 `classifyRank`（含 IC／SIC＝IC，其他＝兵）；shift_records.provenance.row_id 搵返行；搵唔到就跟更別（billing_group=monthly_ic 或 code 含 IC＝IC）。
import { prisma } from "@/lib/db";
import { classifyRank } from "@/lib/roster-upload/match";
import { monthRange } from "@/lib/reports/money";
import type { CoverGrade } from "./cover-rates";

export interface CoverShift {
  guardId: string;
  month: string; // YYYY-MM
  date: string; // YYYY-MM-DD
  siteId: string;
  grade: CoverGrade;
}

export interface CoverShiftLoad {
  shifts: CoverShift[];
  noPostShifts: number;
  sites: Map<string, { name: string; parentSiteId: string | null }>;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export function gradeFromRank(rankRaw: string | null | undefined, billingGroup: string | null | undefined, shiftCode: string | null | undefined): CoverGrade {
  const k = classifyRank(rankRaw);
  if (k === "ic") return "IC";
  if (k === "guard") return "兵";
  if (billingGroup === "monthly_ic" || classifyRank(shiftCode) === "ic") return "IC";
  return "兵";
}

/** 讀指定月份（YYYY-MM 月首 Date）嘅長工頂位更。唔寫任何嘢。 */
export async function loadCoverShifts(months: Date[]): Promise<CoverShiftLoad> {
  const out: CoverShiftLoad = { shifts: [], noPostShifts: 0, sites: new Map() };
  for (const month of months) {
    const { start, end } = monthRange(month);
    const mLabel = ymd(start).slice(0, 7);
    const contracts = await prisma.guardLongtermContract.findMany({
      where: { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
      select: { guardId: true },
    });
    const ids = [...new Set(contracts.map((c) => c.guardId))];
    if (ids.length === 0) continue;
    const guards = await prisma.guard.findMany({ where: { id: { in: ids }, visaSponsoredByBrokerId: null }, select: { id: true } });
    const guardIds = guards.map((g) => g.id);
    if (guardIds.length === 0) continue;
    const posts = await prisma.guardLongtermPost.findMany({ where: { guardId: { in: guardIds }, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] }, select: { guardId: true, siteId: true, effectiveFrom: true, effectiveTo: true } });
    const postsByGuard = new Map<string, typeof posts>();
    for (const p of posts) postsByGuard.set(p.guardId, [...(postsByGuard.get(p.guardId) ?? []), p]);
    const recs = await prisma.shiftRecord.findMany({
      where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: "shift" },
      select: { guardId: true, workDate: true, siteId: true, provenance: true, shiftType: { select: { code: true, billingGroup: true } }, site: { select: { canonicalName: true, parentSiteId: true } } },
      orderBy: [{ workDate: "asc" }],
    });
    const rowIds = new Set<string>();
    for (const r of recs) {
      const rid = r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? (r.provenance as Record<string, unknown>).row_id : null;
      if (typeof rid === "string") rowIds.add(rid);
    }
    const rankByRow = new Map<string, string | null>();
    const rowList = [...rowIds];
    for (let i = 0; i < rowList.length; i += 1000) {
      const rows = await prisma.rosterUploadRow.findMany({ where: { id: { in: rowList.slice(i, i + 1000) } }, select: { id: true, rankRaw: true } });
      for (const r of rows) rankByRow.set(r.id, r.rankRaw);
    }
    for (const r of recs) {
      const date = ymd(r.workDate);
      const gp = (postsByGuard.get(r.guardId) ?? []).filter((p) => ymd(p.effectiveFrom) <= date && (!p.effectiveTo || ymd(p.effectiveTo) >= date));
      if (gp.length === 0) {
        out.noPostShifts++;
        continue;
      }
      const postSites = new Set(gp.map((p) => p.siteId));
      if (postSites.has(r.siteId) || (r.site.parentSiteId && postSites.has(r.site.parentSiteId))) continue;
      const rid = r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? (r.provenance as Record<string, unknown>).row_id : null;
      const grade = gradeFromRank(typeof rid === "string" ? rankByRow.get(rid) : null, r.shiftType.billingGroup, r.shiftType.code);
      out.sites.set(r.siteId, { name: r.site.canonicalName, parentSiteId: r.site.parentSiteId });
      out.shifts.push({ guardId: r.guardId, month: mLabel, date, siteId: r.siteId, grade });
    }
  }
  return out;
}
