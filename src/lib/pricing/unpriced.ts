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
export type UnpricedCategory = "payout_unpriced" | "client_unpriced";

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
};

export function computeUnpricedSummary(records: UnpricedRecordLike[], lookups: UnpricedLookups): UnpricedSummary {
  const groups = new Map<string, UnpricedGroup>();
  let count = 0;
  let payoutCount = 0;
  let clientCount = 0;
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
    const payoutUnpriced = isUnpricedShift(
      { recordType: "shift", status: r.status, guardWageSnapshot: r.guardWageSnapshot, brokerFeeSnapshot: r.brokerFeeSnapshot, isExternal: r.isExternal },
      brokerKind,
    );
    const clientUnpriced = isClientUnpricedShift(
      { recordType: "shift", status: r.status, clientRateSnapshot: r.clientRateSnapshot, isExternal: r.isExternal },
      shiftTypeBillingGroup,
      { siteBillingModel: lookups.siteBillingModelById.get(r.siteId) ?? null, brokerKind },
    );
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
  if (records.length === 0) return { count: 0, groups: [], payoutCount: 0, clientCount: 0 };

  const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
  const siteIds = [...new Set(records.map((r) => r.siteId))];
  const [brokers, sites, shiftTypes] = await Promise.all([
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, billingModel: true } }),
    prisma.shiftType.findMany({ where: { id: { in: [...new Set(records.map((r) => r.shiftTypeId))] } }, select: { id: true, code: true, billingGroup: true } }),
  ]);
  const lookups: UnpricedLookups = {
    brokerKindById: new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike])),
    brokerCodeById: new Map(brokers.map((b) => [b.id, b.code])),
    siteNameById: new Map(sites.map((s) => [s.id, s.canonicalName])),
    siteBillingModelById: new Map(sites.map((s) => [s.id, (s.billingModel as string | null) ?? null])),
    shiftTypeCodeById: new Map(shiftTypes.map((s) => [s.id, s.code])),
    shiftTypeBillingGroupById: new Map(shiftTypes.map((s) => [s.id, s.billingGroup])),
  };

  return computeUnpricedSummary(records, lookups);
}
