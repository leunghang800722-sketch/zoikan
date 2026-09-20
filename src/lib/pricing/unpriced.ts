// WP-PRICE §3：「未定价」逐組統計——`GET /api/shift-records/unpriced` 同
// 更表編輯器／糧明細／本月應收／毛利即時表／月結工作台嘅頁頂 Notice
// 共用同一份邏輯，唔准逐處各執一詞。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { scopeShiftRecordWhere } from "@/lib/broker-isolation";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { isUnpricedShift, isClientUnpricedShift, type BrokerKindLike } from "./resolve-rate";
import type { Prisma } from "@prisma/client";

// S3：未定价分兩類——payout_unpriced（出街价未定，舊有口徑，加咗
// wage=0&&fee=null）／client_unpriced（收客价未定，淨係逐更盤先算，見
// isClientUnpricedShift()）。`category` 令前端 Notice 可以分開講兩件事，
// `count`/`groups`（向下相容，冇 filter 就係兩類合計）保留舊形狀。
// P0（Opus 驗收重現）：`no_settlement`——`settlement_broker_id` 直情
// NULL 嘅記錄（唔止「未定价」，係喺 `buildPayrollTotals()` 逐 broker 查
// 嗰陣**完全唔會出現**喺任何一個 broker 嘅明細，糧單見唔到呢批更）。
// 同 `payout_unpriced`/`client_unpriced` 獨立計（唔互相排斥——冇結算
// 單位嘅記錄通常都會同時係 payout_unpriced，但呢個分類專門畀用戶睇到
// 「呢批更連邊個雞頭都未定，仲未計『有雞頭但未定价』果種」）。
export type UnpricedCategory = "payout_unpriced" | "client_unpriced" | "no_settlement";

export type UnpricedGroup = {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  category: UnpricedCategory;
  count: number;
};

export type UnpricedSummary = {
  count: number;
  groups: UnpricedGroup[];
  /** S3：分類合計——payout（出街价未定）／client（收客价未定，淨係逐更盤）。 */
  payoutCount: number;
  clientCount: number;
  /** P0：冇結算單位（settlement_broker_id NULL）嘅記錄數——呢批更喺
   * 糧明細會完全消失，唔止未定价咁簡單，前端要獨立高亮。 */
  noSettlementCount: number;
};

/** 必修 2（Opus 第二輪驗收）：`computeUnpricedSummary()` 抽出嚟做純函數——
 * `buildUnpricedSummary()`（真正 DB 讀）同 `POST /api/shift-records/
 * reprice`（見 src/app/api/shift-records/reprice/route.ts）兩邊都要用
 * *同一份* 「未定价」判斷邏輯（`isUnpricedShift`／`isClientUnpricedShift`），
 * 唔可以各執一詞——reprice 嘅 dry-run 冇寫 DB，攞唔到「寫入之後」嘅
 * snapshot，所以淨係 `buildUnpricedSummary()` 做唔到（一定要打 DB）；
 * 抽呢個純函數出嚟等 reprice 用「模擬寫入之後」嘅記錄（after 值）一樣
 * 過返呢度計，保證口徑（邊條算未定价）永遠同 `buildUnpricedSummary()`
 * 一致，唔會有兩套邏輯飄開。 */
export type UnpricedRecordLike = {
  siteId: string;
  shiftTypeId: string;
  settlementBrokerId: string | null;
  status: string;
  guardWageSnapshot: unknown;
  brokerFeeSnapshot: unknown;
  clientRateSnapshot: unknown;
  isExternal: boolean;
};
export type UnpricedLookups = {
  brokerKindById: Map<string, BrokerKindLike>;
  brokerCodeById: Map<string, string | null>;
  siteNameById: Map<string, string>;
  siteBillingModelById: Map<string, string | null>;
  shiftTypeCodeById: Map<string, string>;
  shiftTypeBillingGroupById: Map<string, string>;
  // WP-MISC（老闆 2026-09-20 拍板）：LINK（TKO Gateway 厚A/B/C）呢類
  // 「客戶直接出糧」嘅盤——true 嘅盤一律唔算未定价（payout 同 client
  // 都唔算），見 resolve-rate.ts isUnpricedShift()／isClientUnpricedShift()。
  siteGuardsPaidByClientById: Map<string, boolean>;
};

export function computeUnpricedSummary(records: UnpricedRecordLike[], lookups: UnpricedLookups): UnpricedSummary {
  const groups = new Map<string, UnpricedGroup>();
  let count = 0;
  let payoutCount = 0;
  let clientCount = 0;
  let noSettlementCount = 0;
  function addToGroup(r: UnpricedRecordLike, category: UnpricedCategory, brokerCode: string | null, siteName: string, shiftTypeCode: string) {
    const key = `${category}|${r.siteId}|${r.shiftTypeId}|${r.settlementBrokerId ?? "none"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, {
        site_id: r.siteId,
        site_name: siteName,
        shift_type_code: shiftTypeCode,
        broker_code: brokerCode,
        broker_display: brokerCode ?? "冇雞頭",
        category,
        count: 1,
      });
    }
  }
  for (const r of records) {
    const brokerKind: BrokerKindLike = r.settlementBrokerId ? (lookups.brokerKindById.get(r.settlementBrokerId) ?? null) : null;
    const shiftTypeBillingGroup = lookups.shiftTypeBillingGroupById.get(r.shiftTypeId) ?? "per_shift";
    const guardsPaidByClient = lookups.siteGuardsPaidByClientById.get(r.siteId) ?? false;
    const payoutUnpriced = isUnpricedShift(
      { recordType: "shift", status: r.status, guardWageSnapshot: r.guardWageSnapshot, brokerFeeSnapshot: r.brokerFeeSnapshot, isExternal: r.isExternal },
      brokerKind,
      { guardsPaidByClient },
    );
    const clientUnpriced = isClientUnpricedShift(
      { recordType: "shift", status: r.status, clientRateSnapshot: r.clientRateSnapshot, isExternal: r.isExternal },
      shiftTypeBillingGroup,
      { siteBillingModel: lookups.siteBillingModelById.get(r.siteId) ?? null, brokerKind, guardsPaidByClient },
    );
    // P0：冇結算單位——同 payout/client 獨立計，唔理會呢兩個 flag（LINK
    // 客戶直接出糧盤本身就冇結算單位嘅概念，`guardsPaidByClient` 一樣要
    // 剔走，唔誤報）。
    if (!guardsPaidByClient && r.settlementBrokerId === null) {
      noSettlementCount++;
      const shiftTypeCode = lookups.shiftTypeCodeById.get(r.shiftTypeId) ?? r.shiftTypeId.slice(0, 8);
      const siteName = lookups.siteNameById.get(r.siteId) ?? r.siteId.slice(0, 8);
      addToGroup(r, "no_settlement", null, siteName, shiftTypeCode);
    }
    if (!payoutUnpriced && !clientUnpriced) continue;
    count++;
    const shiftTypeCode = lookups.shiftTypeCodeById.get(r.shiftTypeId) ?? r.shiftTypeId.slice(0, 8);
    const siteName = lookups.siteNameById.get(r.siteId) ?? r.siteId.slice(0, 8);
    const brokerCode = r.settlementBrokerId ? (lookups.brokerCodeById.get(r.settlementBrokerId) ?? null) : null;
    if (payoutUnpriced) {
      payoutCount++;
      addToGroup(r, "payout_unpriced", brokerCode, siteName, shiftTypeCode);
    }
    if (clientUnpriced) {
      clientCount++;
      addToGroup(r, "client_unpriced", brokerCode, siteName, shiftTypeCode);
    }
  }
  return {
    count,
    payoutCount,
    clientCount,
    noSettlementCount,
    groups: [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || a.site_name.localeCompare(b.site_name) || a.shift_type_code.localeCompare(b.shift_type_code)),
  };
}

export async function buildUnpricedSummary(session: AuthedSession, month: Date, siteId?: string | null, brokerId?: string | null): Promise<UnpricedSummary> {
  const { start, end } = monthRange(month);
  let where: Prisma.ShiftRecordWhereInput = {
    recordType: "shift",
    status: { not: "cancelled" },
    workDate: { gte: start, lte: end },
    ...(siteId ? { siteId } : {}),
    // P2-B「本月應收」`?broker=` 預覽分支用——內部角色 session 本身唔經
    // scopeShiftRecordWhere() 隔離，呢個參數等預覽某個雞頭嗰陣淨係計
    // 佢自己嘅未定价（唔係全公司）。
    ...(brokerId ? { settlementBrokerId: brokerId } : {}),
  };
  where = scopeShiftRecordWhere(session, where);

  const records = await prisma.shiftRecord.findMany({
    where,
    select: {
      id: true,
      status: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
      clientRateSnapshot: true,
      settlementBrokerId: true,
      siteId: true,
      shiftTypeId: true,
      isExternal: true,
    },
  });
  if (records.length === 0) return { count: 0, groups: [], payoutCount: 0, clientCount: 0, noSettlementCount: 0 };

  const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
  const siteIds = [...new Set(records.map((r) => r.siteId))];
  const [brokers, sites, shiftTypes] = await Promise.all([
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, billingModel: true, guardsPaidByClient: true } }),
    prisma.shiftType.findMany({ where: { id: { in: [...new Set(records.map((r) => r.shiftTypeId))] } }, select: { id: true, code: true, billingGroup: true } }),
  ]);
  const lookups: UnpricedLookups = {
    brokerKindById: new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike])),
    brokerCodeById: new Map(brokers.map((b) => [b.id, b.code])),
    siteNameById: new Map(sites.map((s) => [s.id, s.canonicalName])),
    siteBillingModelById: new Map(sites.map((s) => [s.id, (s.billingModel as string | null) ?? null])),
    shiftTypeCodeById: new Map(shiftTypes.map((s) => [s.id, s.code])),
    shiftTypeBillingGroupById: new Map(shiftTypes.map((s) => [s.id, s.billingGroup])),
    siteGuardsPaidByClientById: new Map(sites.map((s) => [s.id, s.guardsPaidByClient])),
  };

  return computeUnpricedSummary(records, lookups);
}
