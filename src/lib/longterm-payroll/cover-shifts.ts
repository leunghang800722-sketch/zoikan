// P10.2：長工「頂位更」認定（唯讀），同 aggregate 口徑一致（共用 `classifyLongtermShift`）：
// 非簽證長工、recordType=shift、settlement_broker_id 有值且 ≠ B07（internal_longterm）＝頂位更（幫雞頭頂散更）；
// B07 或 null＝自己崗位。崗位盤判斷（母盤／構造盤 activityProxy 摺疊、Postorder 權威月只認 manual）已在對數時寫入 settlement，呢度唔再自己查崗位。
// 注意：呢啲更喺 aggregate 已經由雞頭現金結算（唔當長工返工日）——是否再出頂位津貼會唔會雙重支付，要老闆決定（見 P3 §14.2）。
// 職級 grade：更表行 `rank_raw` 經 `classifyRank`（含 IC／SIC＝IC，其他＝兵）；搵唔到行就跟更別（billing_group=monthly_ic 或 code 含 IC）。
import { prisma } from "@/lib/db";
import { classifyRank } from "@/lib/roster-upload/match";
import { findInternalLongtermBrokerId } from "@/lib/pricing/longterm-settlement";
import { classifyLongtermShift } from "./shift-classify";
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
  const out: CoverShiftLoad = { shifts: [], sites: new Map() };
  const internalId = await findInternalLongtermBrokerId();
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
    const recs = await prisma.shiftRecord.findMany({
      where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: "shift" },
      select: { guardId: true, workDate: true, siteId: true, settlementBrokerId: true, provenance: true, shiftType: { select: { code: true, billingGroup: true } }, site: { select: { canonicalName: true, parentSiteId: true } } },
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
      if (classifyLongtermShift(r.settlementBrokerId, internalId) !== "cover") continue;
      const date = ymd(r.workDate);
      const rid = r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? (r.provenance as Record<string, unknown>).row_id : null;
      const grade = gradeFromRank(typeof rid === "string" ? rankByRow.get(rid) : null, r.shiftType.billingGroup, r.shiftType.code);
      out.sites.set(r.siteId, { name: r.site.canonicalName, parentSiteId: r.site.parentSiteId });
      out.shifts.push({ guardId: r.guardId, month: mLabel, date, siteId: r.siteId, grade });
    }
  }
  return out;
}
