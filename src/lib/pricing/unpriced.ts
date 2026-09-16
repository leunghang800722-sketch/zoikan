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
    select: { id: true, status: true, guardWageSnapshot: true, brokerFeeSnapshot: true, clientRateSnapshot: true, settlementBrokerId: true, siteId: true, shiftTypeId: true },
  });
  if (records.length === 0) return { count: 0, groups: [], payoutCount: 0, clientCount: 0 };

  const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
  const siteIds = [...new Set(records.map((r) => r.siteId))];
  const [brokers, sites, shiftTypes] = await Promise.all([
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, billingModel: true } }),
    prisma.shiftType.findMany({ where: { id: { in: [...new Set(records.map((r) => r.shiftTypeId))] } }, select: { id: true, code: true } }),
  ]);
  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));

  const groups = new Map<string, UnpricedGroup>();
  let count = 0;
  let payoutCount = 0;
  let clientCount = 0;
  function addToGroup(r: (typeof records)[number], category: UnpricedCategory, brokerCode: string | null, siteName: string, shiftTypeCode: string) {
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
    const brokerRow = r.settlementBrokerId ? brokerById.get(r.settlementBrokerId) : undefined;
    const brokerKind: BrokerKindLike = (brokerRow?.kind as BrokerKindLike) ?? null;
    const siteRow = siteById.get(r.siteId);
    const payoutUnpriced = isUnpricedShift({ recordType: "shift", status: r.status, guardWageSnapshot: r.guardWageSnapshot, brokerFeeSnapshot: r.brokerFeeSnapshot }, brokerKind);
    const clientUnpriced = isClientUnpricedShift({ recordType: "shift", status: r.status, clientRateSnapshot: r.clientRateSnapshot }, siteRow?.billingModel ?? "per_shift");
    if (!payoutUnpriced && !clientUnpriced) continue;
    count++;
    const shiftTypeCode = shiftTypeById.get(r.shiftTypeId)?.code ?? r.shiftTypeId.slice(0, 8);
    const siteName = siteRow?.canonicalName ?? r.siteId.slice(0, 8);
    const brokerCode = brokerRow?.code ?? null;
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
