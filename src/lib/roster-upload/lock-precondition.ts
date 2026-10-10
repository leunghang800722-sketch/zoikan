// WP-ROSTER-UPLOAD Phase B-1（B1-6）：月結鎖定前檢查——規則 10（§14）
// 「月結鎖定前要齊上載（有出更嘅盤未上載→擋鎖，列清單）」。呢個檔案淨係
// 負責「呢個月邊啲盤未上載／未對數完成」呢個查詢，月結鎖定 route
// （src/app/api/month-closes/[id]/lock/route.ts）用嚟決定擋唔擋。
import { prisma } from "@/lib/db";
import { monthStart } from "@/lib/month-lock";

interface RosterCoverageIssueSite {
  siteId: string;
  siteName: string;
}

export interface RosterCoverageCheckResult {
  /** 呢個月有 shift_records／daily_requirements，但完全冇 active（唔係
   * superseded）roster_upload 嘅盤——要先上載。 */
  missingUploadSites: RosterCoverageIssueSite[];
  /** 有上載但 status != 'confirmed'（未對數完成）嘅盤。 */
  unconfirmedUploadSites: (RosterCoverageIssueSite & { status: string })[];
}

/** 驗收修正（Opus 5.5）：規則 10 淨係對「更表上載制度開始之後」嘅月份
 * 生效——2026-07（P0 已鎖定入庫、數據來自 importer，冇任何更表上載）同
 * 更早月份唔檢查，否則 7 月一旦解鎖改嘢再鎖，就會俾呢條規則擋住（要老闆
 * force）。8 月係第一個用更表上載計糧嘅月份（§15）。 */
const ROSTER_UPLOAD_REQUIRED_FROM = new Date(Date.UTC(2026, 7, 1));

/** 規則 10：邊啲盤呢個月有出更（shift_records 或 daily_requirements）但
 * 未齊上載／未對數完成。 */
export async function checkRosterUploadCoverage(month: Date): Promise<RosterCoverageCheckResult> {
  const m = monthStart(month);
  if (m < ROSTER_UPLOAD_REQUIRED_FROM) return { missingUploadSites: [], unconfirmedUploadSites: [] };
  const monthEnd = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));

  const [shiftSiteIds, requirementSiteIds] = await Promise.all([
    prisma.shiftRecord.findMany({ where: { workDate: { gte: m, lte: monthEnd }, status: { not: "cancelled" } }, select: { siteId: true }, distinct: ["siteId"] }),
    prisma.dailyRequirement.findMany({ where: { workDate: { gte: m, lte: monthEnd }, voidedAt: null }, select: { siteId: true }, distinct: ["siteId"] }),
  ]);
  const siteIds = [...new Set([...shiftSiteIds.map((s) => s.siteId), ...requirementSiteIds.map((s) => s.siteId)])];
  if (siteIds.length === 0) return { missingUploadSites: [], unconfirmedUploadSites: [] };

  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, parentSiteId: true } });
  // 驗收修正（Opus 5.5）：子盤（城巴車廠／CP5）嘅更係由母盤嗰份上載
  // 覆蓋（B-0：一檔多子盤，上載掛母盤）——子盤本身冇上載唔算「未上載」。
  const parentBySite = new Map(sites.map((s) => [s.id, s.parentSiteId]));
  const uploadSiteIds = [...new Set([...siteIds, ...sites.map((s) => s.parentSiteId).filter((v): v is string => !!v)])];
  // WP-UPLOAD-VOID：`voided` 唔算「已上載」——作廢咗嘅上載唔應該令一個
  // 冇齊上載嘅盤逃過月結鎖定前置檢查。
  const uploads = await prisma.rosterUpload.findMany({ where: { month: m, siteId: { in: uploadSiteIds }, status: { notIn: ["superseded", "voided"] } }, select: { siteId: true, status: true } });
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  // 同盤理論上淨係一個 active（version 序列已經保證），但保守用 Map 揀
  // 「非 superseded 入面隨便一個」——真係有多過一個都代表資料有問題，
  // 呢度唔負責修呢種歷史異常，淨係用嚟判斷「有冇齊上載」。
  const uploadBySite = new Map(uploads.map((u) => [u.siteId as string, u.status]));

  const missingUploadSites: RosterCoverageIssueSite[] = [];
  const unconfirmedUploadSites: (RosterCoverageIssueSite & { status: string })[] = [];
  for (const siteId of siteIds) {
    const siteName = siteNameById.get(siteId) ?? siteId.slice(0, 8);
    const parentId = parentBySite.get(siteId) ?? null;
    const status = uploadBySite.get(siteId) ?? (parentId ? uploadBySite.get(parentId) : undefined);
    if (!status) {
      missingUploadSites.push({ siteId, siteName });
    } else if (status !== "confirmed") {
      unconfirmedUploadSites.push({ siteId, siteName, status });
    }
  }
  return { missingUploadSites, unconfirmedUploadSites };
}
