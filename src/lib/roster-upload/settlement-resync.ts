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
import {
  isLongtermEmploymentType,
  resolveLongtermSettlement,
  findInternalLongtermBrokerId,
  loadActiveLongtermPosts,
  inferGuardMonthlyTopSite,
  hasParsedPostorderForMonth,
} from "@/lib/pricing/longterm-settlement";
import { resolveShiftPricing, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { numOrNull } from "@/lib/pricing/reprice";

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

/** 8 月起 B07 格唔帶 guard_wage／broker_fee（同 resolve-rate.ts 一致）。 */
const LONGTERM_SNAPSHOT_CLEAN_FROM = new Date("2026-08-01T00:00:00.000Z");

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
    select: {
      id: true,
      guardId: true,
      siteId: true,
      settlementBrokerId: true,
      operationalBrokerId: true,
      workDate: true,
      recordType: true,
      isExternal: true,
      shiftTypeId: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
      otHours: true,
      shiftType: { select: { code: true, billingGroup: true } },
      site: { select: { guardsPaidByClient: true } },
    },
  });
  if (records.length === 0) return EMPTY;

  const guardIds = [...new Set(records.map((r) => r.guardId))];
  const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, employmentType: true, visaSponsoredByBrokerId: true } });
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const longtermGuardIds = guards.filter((g) => isLongtermEmploymentType(g.employmentType)).map((g) => g.id);
  const longtermRecords = records.filter((r) => longtermGuardIds.includes(r.guardId));
  if (longtermRecords.length === 0) return { ...EMPTY, scanned: records.length };

  // 驗收（Opus 5.5）：本月有 Postorder（權威）→ 唔推算、唔睇 inferred 崗位
  // （同 reconcile.ts 一致）。
  const postorderAuthoritative = await hasParsedPostorderForMonth(monthStartDate);
  const [internalLongtermBrokerId, activePostsByGuard, monthlyTopSiteByGuard] = await Promise.all([
    findInternalLongtermBrokerId(prisma),
    loadActiveLongtermPosts(longtermGuardIds, monthStartDate, prisma, { excludeInferred: postorderAuthoritative }),
    postorderAuthoritative ? Promise.resolve(new Map<string, { siteId: string; ratio: number }>()) : inferGuardMonthlyTopSite(longtermGuardIds, monthStartDate),
  ]);

  const changes: RecomputeSettlementChange[] = [];
  const updates: {
    id: string;
    settlementBrokerId: string | null;
    operationalBrokerId: string | null;
    /** null＝唔郁 snapshot（LINK 盤／leave／PR 佔位，同 reconcile-apply 一致）。 */
    pricing: { clientRateSnapshot: number | null; guardWageSnapshot: number | null; brokerFeeSnapshot: number | null } | null;
  }[] = [];
  const brokerKindById = new Map<string, BrokerKindLike>((await prisma.broker.findMany({ select: { id: true, kind: true } })).map((b) => [b.id, b.kind as BrokerKindLike]));

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
      postorderAuthoritative,
    });
    if (!lt) continue;
    const usable = !((lt.reason === "longterm_non_post_broker" || lt.reason === "longterm_no_post_postorder") && !(r.operationalBrokerId ?? r.settlementBrokerId));
    if (!usable) continue;
    const nextSettlement = lt.settlementBrokerId ?? internalLongtermBrokerId;
    const nextOperational = lt.operationalBrokerId ?? nextSettlement;
    // 驗收（Opus 5.5）：結算單位冇變、但係 B07 格仲帶住舊版 resolver 寫落嘅
    // guard_wage／broker_fee（8 月起 B07 兩樣都應該 null，見 resolve-rate.ts）
    // ——一樣要重新定價，否則正式站之前套用嘅 B07 格會一直帶住假成本。
    const staleLongtermSnapshot =
      nextSettlement !== null &&
      nextSettlement === r.settlementBrokerId &&
      brokerKindById.get(nextSettlement) === "internal_longterm" &&
      monthStartDate >= LONGTERM_SNAPSHOT_CLEAN_FROM &&
      (r.guardWageSnapshot !== null || r.brokerFeeSnapshot !== null);
    if (nextSettlement === r.settlementBrokerId && nextOperational === r.operationalBrokerId && !staleLongtermSnapshot) continue;
    // 驗收（Opus 5.5）：結算單位變咗就要重新定價——之前淨係改 broker id、
    // 唔郁 snapshot：K→B07 會留低 K 外判價（B07 當咗有成本）、B07→K 會
    // 留低 null（K 少收錢）；而之後嘅 reconcileUpload() 見 roster＝system
    // 已經 match，唔會再經 settlement_diff 重新定價。規則同
    // reconcile-apply.ts computeRosterPricing() 一致：LINK 盤、leave、「PR」
    // 對數佔位記錄唔郁 snapshot。
    let pricing: (typeof updates)[number]["pricing"] = null;
    const settlementChanged = nextSettlement !== r.settlementBrokerId || staleLongtermSnapshot;
    if (settlementChanged && !r.site.guardsPaidByClient && r.recordType !== "leave" && r.shiftType.code !== "PR") {
      const resolved = await resolveShiftPricing({
        siteId: r.siteId,
        shiftTypeId: r.shiftTypeId,
        shiftTypeCode: r.shiftType.code,
        shiftTypeBillingGroup: r.shiftType.billingGroup ?? "per_shift",
        settlementBrokerId: nextSettlement,
        brokerKind: nextSettlement ? (brokerKindById.get(nextSettlement) ?? null) : null,
        guardId: r.guardId,
        workDate: r.workDate,
        isExternal: r.isExternal,
        recordType: r.recordType === "ot" ? "ot" : "shift",
        // WP-BOSS5 §25.1：OT 卡＝每小時价，要傳呢條記錄本身嘅 OT 時數。
        otHours: numOrNull(r.otHours),
      });
      pricing = { clientRateSnapshot: resolved.clientRate, guardWageSnapshot: resolved.guardWage, brokerFeeSnapshot: resolved.brokerFee };
    }
    changes.push({
      shiftRecordId: r.id,
      fromSettlementBrokerId: r.settlementBrokerId,
      toSettlementBrokerId: nextSettlement,
      fromOperationalBrokerId: r.operationalBrokerId,
      toOperationalBrokerId: nextOperational,
      reason: lt.reason,
    });
    updates.push({ id: r.id, settlementBrokerId: nextSettlement, operationalBrokerId: nextOperational, pricing });
  }

  if (updates.length === 0) return { scanned: records.length, longtermScanned: longtermRecords.length, changed: 0, changes: [] };

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const u of updates) {
      const sel = { id: true, settlementBrokerId: true, operationalBrokerId: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true } as const;
      const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: u.id }, select: sel });
      const after = await tx.shiftRecord.update({
        where: { id: u.id },
        data: { settlementBrokerId: u.settlementBrokerId, operationalBrokerId: u.operationalBrokerId, ...(u.pricing ?? {}) },
        select: sel,
      });
      await writeAuditTx(tx, { actorUserId, tableName: "shift_records", rowId: u.id, action: "update", before, after, ip: null });
    }
  }, { timeout: 120_000, maxWait: 10_000 });

  return { scanned: records.length, longtermScanned: longtermRecords.length, changed: updates.length, changes };
}
