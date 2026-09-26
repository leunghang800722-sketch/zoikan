// WP-LTSHIFT §19 交付 C：`recomputeSettlement(uploadId)`——「重新對數
// 全月」一鍵嘅第一步。淨係重算已經寫入 `shift_records` 嘅長工格
// （`employment_type` 開頭 `longterm_`）嘅 settlement_broker_id／
// operational_broker_id，**唔換 row id**（純 UPDATE 現有 shift_record，
// 唔 cancel／唔新建），對 `confirmed` 上載都安全（唔似 `reparseRoster
// Upload()` 咁會整棟重建 roster_upload_rows）。
//
// 點解要呢個獨立步驟，唔淨係靠 `reconcileUpload()` 嘅 settlement_diff
// 分類：settlement_diff 淨係喺「更表行 vs 系統記錄」四要素（日期／盤／
// 人／更別）夾中先會被比較——如果一個 shift_record 因為其他原因（例如
// 更別暫時對唔上）而未被歸類做 `match`，佢嘅 settlement 就唔會經
// settlement_diff 呢條路修正。呢個函數直接掃返呢張上載（盤＋子盤＋
// 月份）scope 入面全部生效 shift_records，唔靠配對，`guard_longterm_
// posts`／`guards.referral_broker_id`／`visa_sponsored_by_broker_id`
// 一有更新（例如 guard-fix set_longterm_post 啱啱套用咗）就即刻全部
// 生效。
//
// 淨係改長工格：非長工安員嘅 settlement 唔關 WP-LTSHIFT 事，舊 fallback
// 鏈（`resolveSettlementBrokerFallback`）唔喺呢度重跑，避免引入新嘅
// 行為變動風險。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthStart as toMonthStart } from "@/lib/month-lock";
import { writeAuditTx } from "@/lib/audit";
import { isLongtermEmploymentType, resolveLongtermSettlement, findInternalLongtermBrokerId, loadActiveLongtermPosts, inferGuardMonthlyTopSite } from "@/lib/pricing/longterm-settlement";

export interface RecomputeSettlementChange {
  shiftRecordId: string;
  fromSettlementBrokerId: string | null;
  toSettlementBrokerId: string | null;
  fromOperationalBrokerId: string | null;
  toOperationalBrokerId: string | null;
  reason: string;
}

export interface RecomputeSettlementResult {
  scanned: number;
  longtermScanned: number;
  changed: number;
  changes: RecomputeSettlementChange[];
}

const EMPTY: RecomputeSettlementResult = { scanned: 0, longtermScanned: 0, changed: 0, changes: [] };

/** 純 UPDATE，一個 transaction（呢張表通常一個盤一個月頂多幾百行，
 * 唔使 SAVEPOINT 逐項——一齊失敗一齊 rollback，冪等，可以安全重試）。
 * `actorUserId=null`＝system 觸發（同 apply.ts SYSTEM_ACTOR 一致做法）。 */
export async function recomputeSettlement(uploadId: string, actorUserId: string | null = null): Promise<RecomputeSettlementResult> {
  const upload = await prisma.rosterUpload.findUnique({ where: { id: uploadId }, select: { id: true, siteId: true, month: true } });
  if (!upload || !upload.siteId) return EMPTY;

  const childSites = await prisma.site.findMany({ where: { parentSiteId: upload.siteId }, select: { id: true, parentSiteId: true } });
  const siteIds = [upload.siteId, ...childSites.map((s) => s.id)];
  const siteParentMap = new Map<string, string | null>([[upload.siteId, null], ...childSites.map((s): [string, string | null] => [s.id, s.parentSiteId])]);

  const monthStartDate = toMonthStart(upload.month);
  const monthEnd = new Date(Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0));

  const records = await prisma.shiftRecord.findMany({
    where: { siteId: { in: siteIds }, workDate: { gte: monthStartDate, lte: monthEnd }, status: { not: "cancelled" } },
    select: { id: true, guardId: true, siteId: true, settlementBrokerId: true, operationalBrokerId: true },
  });
  if (records.length === 0) return EMPTY;

  const guardIds = [...new Set(records.map((r) => r.guardId))];
  const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, employmentType: true, visaSponsoredByBrokerId: true } });
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const longtermGuardIds = guards.filter((g) => isLongtermEmploymentType(g.employmentType)).map((g) => g.id);
  const longtermRecords = records.filter((r) => longtermGuardIds.includes(r.guardId));
  if (longtermRecords.length === 0) return { ...EMPTY, scanned: records.length };

  const [internalLongtermBrokerId, activePostsByGuard, monthlyTopSiteByGuard] = await Promise.all([
    findInternalLongtermBrokerId(prisma),
    loadActiveLongtermPosts(longtermGuardIds, monthStartDate),
    inferGuardMonthlyTopSite(longtermGuardIds, monthStartDate),
  ]);

  const changes: RecomputeSettlementChange[] = [];
  const updates: { id: string; settlementBrokerId: string | null; operationalBrokerId: string | null }[] = [];

  for (const r of longtermRecords) {
    const guard = guardById.get(r.guardId)!;
    const lt = resolveLongtermSettlement({
      employmentType: guard.employmentType,
      visaSponsoredByBrokerId: guard.visaSponsoredByBrokerId ?? null,
      effectiveSiteId: r.siteId,
      parentSiteId: siteParentMap.get(r.siteId) ?? null,
      // 冇更表行可以睇（呢個 shift_record 可能舊，冇對應現存 roster
      // row）——用現存 operational_broker_id（跌返 settlement）做「更表
      // 雞頭碼」訊號，同 reconcile.ts 一致（規則 8「payload 優先」）。
      rosterBrokerId: r.operationalBrokerId ?? r.settlementBrokerId ?? null,
      activePostSiteIds: activePostsByGuard.get(r.guardId) ?? new Set<string>(),
      monthlyTopSite: monthlyTopSiteByGuard.get(r.guardId) ?? null,
    });
    if (!lt) continue;
    const usable = !(lt.reason === "longterm_non_post_broker" && !(r.operationalBrokerId ?? r.settlementBrokerId));
    if (!usable) continue;
    const nextSettlement = lt.settlementBrokerId ?? internalLongtermBrokerId;
    const nextOperational = lt.operationalBrokerId ?? nextSettlement;
    if (nextSettlement === r.settlementBrokerId && nextOperational === r.operationalBrokerId) continue;
    changes.push({
      shiftRecordId: r.id,
      fromSettlementBrokerId: r.settlementBrokerId,
      toSettlementBrokerId: nextSettlement,
      fromOperationalBrokerId: r.operationalBrokerId,
      toOperationalBrokerId: nextOperational,
      reason: lt.reason,
    });
    updates.push({ id: r.id, settlementBrokerId: nextSettlement, operationalBrokerId: nextOperational });
  }

  if (updates.length === 0) return { scanned: records.length, longtermScanned: longtermRecords.length, changed: 0, changes: [] };

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const u of updates) {
      const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: u.id }, select: { id: true, settlementBrokerId: true, operationalBrokerId: true } });
      const after = await tx.shiftRecord.update({ where: { id: u.id }, data: { settlementBrokerId: u.settlementBrokerId, operationalBrokerId: u.operationalBrokerId }, select: { id: true, settlementBrokerId: true, operationalBrokerId: true } });
      await writeAuditTx(tx, { actorUserId, tableName: "shift_records", rowId: u.id, action: "update", before, after, ip: null });
    }
  }, { timeout: 120_000, maxWait: 10_000 });

  return { scanned: records.length, longtermScanned: longtermRecords.length, changed: updates.length, changes };
}
