// WP-PRICE（老闆 2026-09-16 拍板）：更表儲存自動計價——由 rate_cards
// runtime 揀返一張最貼切嘅有效卡，計出 client_rate_snapshot／
// guard_wage_snapshot／broker_fee_snapshot，唔准再出現「新更次金額靜靜
// 變 0」（見 batch/route.ts 舊版完全冇寫呢三個 snapshot 嘅 bug）。
//
// 優先次序同 scripts/seed/index.ts 嘅 `fallbackRateCard()`（7 月 seed 用
// 嗰套）一致嘅精神（guard 专属 > 雞頭专属 > 通用；同 shift_type 对应优先，
// 其次 shift_type=null 嘅盘级卡），但**唔可以**依赖
// `data/mappings-private/seed-overrides.json`（正式站容器冇 `data/`）——
// runtime 直接由 rate_cards 表現有欄位（含 K 雞頭费拆分之後嘅
// guard_wage/broker_fee）揀卡，唔查任何 gitignored 檔案。
//
// 設計：分兩層——
//   1. `fetchEffectiveRateCards(siteId, monthStart, monthEnd)`：一次
//      query 攞晒呢個盤喺呢個月範圍內任何一日可能生效嘅卡（batch 儲存
//      一次過用，唔會逐格打一次 DB）。
//   2. `resolveShiftPricingFromCards(cards, input)`：純函數，喺記憶體
//      入面對住已經攞返嚟嘅卡揀出呢一格嘅價——單元測試主要測呢層。
// `resolveShiftPricing(input)`：方便單條記錄用（POST /api/shift-records、
// approve 路徑）嘅 wrapper，內部自己攞一次卡。
import { prisma } from "@/lib/db";
import { n } from "@/lib/reports/money";

export type BrokerKindLike = "broker" | "internal_cash" | "internal_longterm" | "external" | "special" | null;

export type ShiftPricingRecordType = "shift" | "leave" | "ot";

export interface ResolveShiftPricingInput {
  siteId: string;
  shiftTypeId: string;
  settlementBrokerId: string | null;
  brokerKind: BrokerKindLike;
  guardId: string;
  workDate: Date;
  isExternal: boolean;
  recordType: ShiftPricingRecordType;
}

export interface ResolvedShiftPricing {
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
  source: { clientCardId?: string; payoutCardId?: string };
  unpriced: boolean;
  reason?: string;
}

export interface RateCardLite {
  id: string;
  shiftTypeId: string | null;
  brokerId: string | null;
  guardId: string | null;
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
  payoutRate: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** 淨係要曆日部分（UTC），同 `work_date`/`effective_from`/`effective_to` 存法一致（@db.Date）。 */
function toUtcDateOnly(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isEffectiveOn(card: RateCardLite, workDate: Date): boolean {
  const day = toUtcDateOnly(workDate);
  if (toUtcDateOnly(card.effectiveFrom) > day) return false;
  if (card.effectiveTo !== null && toUtcDateOnly(card.effectiveTo) < day) return false;
  return true;
}

/**
 * 卡嘅「具體程度」排名（數字越細越具體）——冇任何一項唔夾（guard/broker/
 * shift_type 三個 FK 入面，凡卡有指定值就一定要同輸入相符）就回 null
 * （呢張卡根本唔適用）。
 *   0：guard 专属 + 同 shift_type
 *   1：guard 专属（shift_type 通用）
 *   2：雞頭专属 + 同 shift_type
 *   3：雞頭专属（shift_type 通用）
 *   4：通用（site 级）+ 同 shift_type
 *   5：通用（site 级 flat 卡，shift_type 都通用）
 */
function specificityRank(card: RateCardLite, ctx: { shiftTypeId: string; settlementBrokerId: string | null; guardId: string }): number | null {
  const guardMatches = card.guardId === null || card.guardId === ctx.guardId;
  const brokerMatches = card.brokerId === null || card.brokerId === ctx.settlementBrokerId;
  const shiftTypeMatches = card.shiftTypeId === null || card.shiftTypeId === ctx.shiftTypeId;
  if (!guardMatches || !brokerMatches || !shiftTypeMatches) return null;

  if (card.guardId !== null) return card.shiftTypeId !== null ? 0 : 1;
  if (card.brokerId !== null) return card.shiftTypeId !== null ? 2 : 3;
  return card.shiftTypeId !== null ? 4 : 5;
}

function pickBestCard(
  cards: RateCardLite[],
  ctx: { shiftTypeId: string; settlementBrokerId: string | null; guardId: string; workDate: Date },
  predicate: (c: RateCardLite) => boolean,
): RateCardLite | null {
  let best: RateCardLite | null = null;
  let bestRank = Infinity;
  for (const card of cards) {
    if (!predicate(card)) continue;
    if (!isEffectiveOn(card, ctx.workDate)) continue;
    const rank = specificityRank(card, ctx);
    if (rank === null) continue;
    if (
      rank < bestRank ||
      (rank === bestRank &&
        best !== null &&
        (toUtcDateOnly(card.effectiveFrom) > toUtcDateOnly(best.effectiveFrom) ||
          (toUtcDateOnly(card.effectiveFrom) === toUtcDateOnly(best.effectiveFrom) && card.id > best.id)))
    ) {
      best = card;
      bestRank = rank;
    }
  }
  return best;
}

/** 一次 query 攞晒呢個盤、喺 [monthStart, monthEnd] 範圍內任何一日都可能生效嘅卡（batch 儲存用，唔逐格打 DB）。 */
export async function fetchEffectiveRateCards(siteId: string, monthStart: Date, monthEnd: Date): Promise<RateCardLite[]> {
  const rows = await prisma.rateCard.findMany({
    where: {
      siteId,
      voidedAt: null,
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
  });
  return rows.map((r) => ({
    id: r.id,
    shiftTypeId: r.shiftTypeId,
    brokerId: r.brokerId,
    guardId: r.guardId,
    clientRate: r.clientRate !== null ? n(r.clientRate) : null,
    guardWage: r.guardWage !== null ? n(r.guardWage) : null,
    brokerFee: r.brokerFee !== null ? n(r.brokerFee) : null,
    payoutRate: r.payoutRate !== null ? n(r.payoutRate) : null,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
}

/** 純函數：對住已經攞好嘅卡（喺記憶體）揀出呢一格嘅價。單元測試主力測呢個。 */
export function resolveShiftPricingFromCards(cards: RateCardLite[], input: ResolveShiftPricingInput): ResolvedShiftPricing {
  if (input.recordType !== "shift") {
    // leave／ot 冇「呢更嘅收客/出街价」呢個概念（OT 應該按鐘計，留返報表層），
    // 同 7 月 seed 口徑一致：唔算「未定价」。
    return { clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: false };
  }

  const ctx = { shiftTypeId: input.shiftTypeId, settlementBrokerId: input.settlementBrokerId, guardId: input.guardId, workDate: input.workDate };

  // ---- 收客价：external／长工都要计（收入照計）----------------------
  const clientCard = pickBestCard(cards, ctx, (c) => c.clientRate !== null);
  const clientRate = clientCard ? clientCard.clientRate : null;
  const source: ResolvedShiftPricing["source"] = {};
  if (clientCard) source.clientCardId = clientCard.id;

  const isExternal = input.isExternal || input.brokerKind === "external";
  if (isExternal) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: false, reason: "external" };
  }
  if (input.brokerKind === "internal_longterm") {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: false, reason: "longterm" };
  }
  if (!input.settlementBrokerId) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true, reason: "no_broker" };
  }

  // ---- 出街价：guard_wage/broker_fee 齐 → 照拆；只有其中一個（或者淨係
  // payout_rate）→ guardWage=payout_rate（或 guard_wage）、brokerFee=0
  // （同 7 月 W/G/D「合計」口徑一致）；乜都冇 → unpriced。
  const payoutCard = pickBestCard(cards, ctx, (c) => c.guardWage !== null || c.payoutRate !== null);
  if (!payoutCard) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true };
  }
  source.payoutCardId = payoutCard.id;

  let guardWage: number;
  let brokerFee: number;
  if (payoutCard.guardWage !== null && payoutCard.brokerFee !== null) {
    guardWage = payoutCard.guardWage;
    brokerFee = payoutCard.brokerFee;
  } else if (payoutCard.payoutRate !== null) {
    guardWage = payoutCard.payoutRate;
    brokerFee = 0;
  } else {
    // payoutCard.guardWage !== null（predicate 保證），brokerFee/payoutRate 皆 null
    guardWage = payoutCard.guardWage as number;
    brokerFee = 0;
  }

  return { clientRate, guardWage, brokerFee, source, unpriced: false };
}

/** 方便單條記錄用（POST /api/shift-records、approve 補計）——內部自己攞一次卡（唔係 batch，一次一條可以接受）。 */
export async function resolveShiftPricing(input: ResolveShiftPricingInput): Promise<ResolvedShiftPricing> {
  const day = input.workDate;
  const cards = await fetchEffectiveRateCards(input.siteId, day, day);
  return resolveShiftPricingFromCards(cards, input);
}

/**
 * 「未定价」定義（規劃裁定，WP-PRICE §3）：record_type=shift、非
 * cancelled、guard_wage_snapshot／broker_fee_snapshot 都係 null、broker
 * kind 唔係 internal_longterm／external（呢兩類 wage/fee=null 屬正常，
 * 唔算未定价）。
 */
export function isUnpricedShift(
  record: { recordType: string; status: string; guardWageSnapshot: unknown; brokerFeeSnapshot: unknown },
  brokerKind: BrokerKindLike,
): boolean {
  if (record.recordType !== "shift") return false;
  if (record.status === "cancelled") return false;
  if (brokerKind === "internal_longterm" || brokerKind === "external") return false;
  const wageNull = record.guardWageSnapshot === null || record.guardWageSnapshot === undefined;
  const feeNull = record.brokerFeeSnapshot === null || record.brokerFeeSnapshot === undefined;
  return wageNull && feeNull;
}
