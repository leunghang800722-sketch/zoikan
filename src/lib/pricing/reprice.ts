// 驗收修正（2026-09-26）：抽出嚟嘅「單條 shift_record 重新計价」核心
// 決策規則——`POST /api/shift-records/reprice`（更表頁「重新計价」掣，
// 老闆人手撳，`mode:"full"`）同 `runReconcileAllForMonth()`（「重新對數
// 全月」開頭自動行一次，`mode:"fill_and_fix_b07"`，見
// src/lib/roster-upload/reconcile-all.ts）共用**同一個**純函數
// `decideReprice()`——避免兩處各自維護一套「幾時覆蓋、幾時保留」嘅規則
// 令判斷邏輯日後拗開（呢個 WP 成個problem 嘅根源就係規則喺兩個地方各
// 寫一次、慢慢唔一致）。
//
// 兩種模式：
//   full —— 更表頁畀老闆人手撳，dry-run 預覽之後先確認寫入（見
//     `src/app/api/shift-records/reprice/route.ts`）：resolver 揾到就
//     覆蓋（包括覆蓋緊已經有值嘅收客/出街价，用嚟追返卡啱啱補／改咗
//     嘅新价）；揾唔到就保留原值（`keptUnresolved`）。internal_longterm
//     （B07）／external 嘅出街价（wage／fee）永遠唔喺呢個模式郁（呢兩類
//     嘅 wage/fee 由 `settlement-resync.ts` 專門處理，見
//     `recomputeSettlement()`）。
//   fill_and_fix_b07 —— `runReconcileAllForMonth()` 開頭自動行一次，冇人
//     睇住 dry-run 預覽，要保守好多：淨係補「而家係 null」嘅欄位（唔會
//     覆蓋人手／之前已經計過嘅非 null 价錢），**除咗** internal_longterm
//     （B07）嘅 guard_wage／broker_fee——呢兩個欄位 B07 永遠應該係 null
//     （8 月起；見 resolve-rate.ts「B07 snapshot」段），一旦條記錄而家係 B07 但仲帶住舊嘅非 null
//     wage/fee（例如之前用 K／外判雞頭嘅卡計過、之後先改咗做 B07），
//     就要覆蓋返做 null——呢啲先叫「B07 舊價」，唔算人手价。8 月
//     （LONGTERM_REFERRAL_AUTOCOMPUTE_FROM）之前嘅記錄呢個模式**完全
//     唔郁**（驗收修正：7 月已過 gate，唔靠資料巧合保證）。兩種模式都一樣：`guardsPaidByClient` 嘅盤（LINK）
//     完全唔郁。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { monthRange } from "@/lib/reports/money";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, LONGTERM_REFERRAL_AUTOCOMPUTE_FROM, type BrokerKindLike, type RateCardLite, type ShiftPricingRecordType } from "./resolve-rate";

export type RepriceMode = "full" | "fill_and_fix_b07";

export interface RepriceRecordInput {
  id: string;
  siteId: string;
  shiftTypeId: string;
  guardId: string;
  settlementBrokerId: string | null;
  workDate: Date;
  isExternal: boolean;
  recordType?: ShiftPricingRecordType;
  clientRateSnapshot: unknown;
  guardWageSnapshot: unknown;
  brokerFeeSnapshot: unknown;
}

export interface RepriceLookups {
  brokerKindById: Map<string, BrokerKindLike>;
  shiftTypeCodeById: Map<string, string>;
  shiftTypeBillingGroupById: Map<string, string>;
  /** LINK 呢類盤（保安員由客戶直接出糧）——reprice 完全唔掂，兩種模式
   * 都一致（同 `route.ts` 原有行為一樣）。 */
  siteGuardsPaidByClientById: Map<string, boolean>;
}

export interface RepriceValues {
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
}

export interface RepriceDecision {
  id: string;
  before: RepriceValues;
  after: RepriceValues;
  changed: boolean;
  /** full 模式先有意義：resolver 搵唔到卡、保留咗一個「有意義」嘅原值
   * （唔係本身就係 null）。fill_and_fix_b07 模式一律 false（呢個模式
   * 嘅「保留」係故意、唔算「搵唔到」）。 */
  keptUnresolved: boolean;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return Number((v as { toString(): string }).toString());
}

export function sameRepriceValue(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.005;
}

export function decideReprice(record: RepriceRecordInput, lookups: RepriceLookups, cards: RateCardLite[], mode: RepriceMode): RepriceDecision {
  const beforeClient = numOrNull(record.clientRateSnapshot);
  const beforeWage = numOrNull(record.guardWageSnapshot);
  const beforeFee = numOrNull(record.brokerFeeSnapshot);
  const before: RepriceValues = { clientRate: beforeClient, guardWage: beforeWage, brokerFee: beforeFee };

  // WP-MISC（老闆 2026-09-20 拍板）：LINK 呢類盤完全唔掂。
  const siteGuardsPaidByClient = lookups.siteGuardsPaidByClientById.get(record.siteId) ?? false;
  if (siteGuardsPaidByClient) {
    return { id: record.id, before, after: before, changed: false, keptUnresolved: false };
  }
  // 驗收修正（Opus 5.5）：自動 reprice（reconcile-all 開頭）對 8 月之前嘅
  // 記錄**一律唔郁**——7 月已經過晒 gate，`reconcile-all` 本身冇擋 7 月
  // （淨係靠月鎖），唔可以靠「7 月啱啱好冇 null／冇 B07 舊價」呢類資料
  // 巧合保證 7 月唔變。人手「重新計价」（mode:full）唔受呢條影響。
  if (mode === "fill_and_fix_b07" && record.workDate.getTime() < LONGTERM_REFERRAL_AUTOCOMPUTE_FROM.getTime()) {
    return { id: record.id, before, after: before, changed: false, keptUnresolved: false };
  }

  const brokerKind: BrokerKindLike = record.settlementBrokerId ? (lookups.brokerKindById.get(record.settlementBrokerId) ?? null) : null;
  const pricing = resolveShiftPricingFromCards(cards, {
    siteId: record.siteId,
    shiftTypeId: record.shiftTypeId,
    shiftTypeCode: lookups.shiftTypeCodeById.get(record.shiftTypeId) ?? "",
    shiftTypeBillingGroup: lookups.shiftTypeBillingGroupById.get(record.shiftTypeId) ?? "per_shift",
    settlementBrokerId: record.settlementBrokerId,
    brokerKind,
    guardId: record.guardId,
    workDate: record.workDate,
    isExternal: record.isExternal,
    recordType: record.recordType ?? "shift",
  });

  let afterClient: number | null;
  let afterWage: number | null;
  let afterFee: number | null;
  let keptUnresolved = false;

  if (mode === "full") {
    const neverRepriceWage = brokerKind === "internal_longterm" || brokerKind === "external";
    const clientNotFound = !pricing.clientCardFound;
    const payoutNotFound = neverRepriceWage || !pricing.payoutCardFound;
    afterClient = clientNotFound ? beforeClient : pricing.clientRate;
    afterWage = payoutNotFound ? beforeWage : pricing.guardWage;
    afterFee = payoutNotFound ? beforeFee : pricing.brokerFee;
    const keptClientMeaningful = clientNotFound && beforeClient !== null;
    const keptPayoutMeaningful = payoutNotFound && (beforeWage !== null || beforeFee !== null);
    keptUnresolved = keptClientMeaningful || keptPayoutMeaningful;
  } else {
    // fill_and_fix_b07：收客价淨係補 null，永遠唔覆蓋已有值。
    afterClient = beforeClient === null && pricing.clientCardFound ? pricing.clientRate : beforeClient;
    if (brokerKind === "internal_longterm") {
      // B07 嘅 wage／fee 8 月起（上面已經擋走 8 月前記錄）都應該 null
      // （resolver 無條件咁答；介紹費交返 recomputeReferralFees() 另計）
      // ——覆蓋返做 null 就係修「B07 舊價」。
      afterWage = pricing.guardWage;
      afterFee = pricing.brokerFee;
    } else {
      const neverRepriceWage = brokerKind === "external";
      afterWage = beforeWage === null && !neverRepriceWage && pricing.payoutCardFound ? pricing.guardWage : beforeWage;
      afterFee = beforeFee === null && !neverRepriceWage && pricing.payoutCardFound ? pricing.brokerFee : beforeFee;
    }
  }

  const after: RepriceValues = { clientRate: afterClient, guardWage: afterWage, brokerFee: afterFee };
  const changed = !(sameRepriceValue(before.clientRate, after.clientRate) && sameRepriceValue(before.guardWage, after.guardWage) && sameRepriceValue(before.brokerFee, after.brokerFee));
  return { id: record.id, before, after, changed, keptUnresolved };
}

const BATCH_SIZE = 500;

export interface RepriceMonthResult {
  scanned: number;
  changed: number;
}

/** 驗收修正（任務 3）：`runReconcileAllForMonth()` 開頭自動幫呢個月
 * 有上載嘅盤先 reprice 一次（`mode:"fill_and_fix_b07"`）——同更表頁
 * 「重新計价」（`POST /api/shift-records/reprice`）一樣用
 * `decideReprice()`，但保守好多（見檔頭註解），冇 dry-run、直接寫（分批
 * ≤500 一個 transaction，同 reprice route S6 一致）＋一行 audit（action
 * `reprice_month`，`after` 存 counts，唔存逐條——呢個係自動步驟，唔係
 * 老闆主動撳嘅動作，唔使好似人手 reprice 咁存返晒逐條 before/after 俾
 * 人覆核 revert）。`siteIds` 空 → 0 行，唔查 DB。 */
export async function repriceMonthForSites(month: Date, siteIds: string[], actorUserId: string, ip: string | null): Promise<RepriceMonthResult> {
  const uniqueSiteIds = [...new Set(siteIds)];
  if (uniqueSiteIds.length === 0) return { scanned: 0, changed: 0 };
  const { start, end } = monthRange(month);

  const records = await prisma.shiftRecord.findMany({
    where: { recordType: "shift", status: { not: "cancelled" }, workDate: { gte: start, lte: end }, siteId: { in: uniqueSiteIds } },
    select: {
      id: true,
      siteId: true,
      shiftTypeId: true,
      guardId: true,
      settlementBrokerId: true,
      workDate: true,
      isExternal: true,
      clientRateSnapshot: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
    },
  });
  if (records.length === 0) return { scanned: 0, changed: 0 };

  const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
  const shiftTypeIdList = [...new Set(records.map((r) => r.shiftTypeId))];
  const [brokers, sites, shiftTypes] = await Promise.all([
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true } }) : Promise.resolve([]),
    prisma.site.findMany({ where: { id: { in: uniqueSiteIds } }, select: { id: true, guardsPaidByClient: true } }),
    prisma.shiftType.findMany({ where: { id: { in: shiftTypeIdList } }, select: { id: true, code: true, billingGroup: true } }),
  ]);
  const lookups: RepriceLookups = {
    brokerKindById: new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike])),
    shiftTypeCodeById: new Map(shiftTypes.map((s) => [s.id, s.code])),
    shiftTypeBillingGroupById: new Map(shiftTypes.map((s) => [s.id, s.billingGroup])),
    siteGuardsPaidByClientById: new Map(sites.map((s) => [s.id, s.guardsPaidByClient])),
  };
  const cardsEntries = await Promise.all(uniqueSiteIds.map(async (siteId) => [siteId, await fetchEffectiveRateCards(siteId, start, end)] as const));
  const cardsBySite = new Map(cardsEntries);

  const changedUpdates: Array<{ id: string; clientRate: number | null; guardWage: number | null; brokerFee: number | null }> = [];
  for (const r of records) {
    const decision = decideReprice(r, lookups, cardsBySite.get(r.siteId) ?? [], "fill_and_fix_b07");
    if (decision.changed) changedUpdates.push({ id: r.id, clientRate: decision.after.clientRate, guardWage: decision.after.guardWage, brokerFee: decision.after.brokerFee });
  }

  for (let i = 0; i < changedUpdates.length; i += BATCH_SIZE) {
    const batch = changedUpdates.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((u) => prisma.shiftRecord.update({ where: { id: u.id }, data: { clientRateSnapshot: u.clientRate, guardWageSnapshot: u.guardWage, brokerFeeSnapshot: u.brokerFee } })),
    );
  }

  if (changedUpdates.length > 0) {
    await writeAudit({
      actorUserId,
      tableName: "shift_records",
      rowId: `reprice_auto:${month.toISOString().slice(0, 10)}`,
      action: "reprice_month",
      after: { month: month.toISOString().slice(0, 10), site_count: uniqueSiteIds.length, scanned: records.length, changed: changedUpdates.length, mode: "fill_and_fix_b07", trigger: "reconcile-all" },
      ip,
    });
  }

  return { scanned: records.length, changed: changedUpdates.length };
}
