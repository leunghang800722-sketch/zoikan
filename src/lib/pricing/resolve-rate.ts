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
  /** gate:pricing 對 7 月數據驗證發現嘅類別——code="PR" 嘅更別（label
   * 統一係「糧明細生成（更表冇對應資料）」，seed 匯入時因為糧明細有
   * 資料、但更表冇對應記錄先起呢類 placeholder 更別，唔係正式更表更別）
   * 唔可以套用其他更別通用嘅雞頭/保安員泛用卡（guard/broker 专属但
   * shift_type_id=null 嗰批）——呢類更別本身冇一個穩定嘅「呢個保安員/
   * 雞頭嘅正更價」概念可以援用，淨係可以用直接掛咗呢個更別 id 嘅卡
   * （極罕見）。見 `requireExactShiftTypeMatch()`。 */
  shiftTypeCode: string;
  settlementBrokerId: string | null;
  brokerKind: BrokerKindLike;
  guardId: string;
  workDate: Date;
  isExternal: boolean;
  recordType: ShiftPricingRecordType;
}

/** 見 `ResolveShiftPricingInput.shiftTypeCode` 註解——目前淨係 "PR"
 * （糧明細生成 reconciliation placeholder）呢一類。獨立做一個函數方便
 * 之後如果多一類都喺呢度加，唔使周圍散落住字串比較。 */
function requireExactShiftTypeMatch(shiftTypeCode: string): boolean {
  return shiftTypeCode === "PR";
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
  /** M1（Opus 驗收）：呢張卡本身嘅收費模式——`null`／`per_shift` 先可以
   * 做「逐更」snapshot；`monthly_fixed`／`admin_fee`／`special` 嘅盤級
   * 「成個月總額」卡、更別級 special 卡（例如 Event Guard $11,700）唔可以
   * 誤畀逐更 resolver 揀中（見 `isPerShiftEligible()`）。 */
  billingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special" | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** M1：淨係 `per_shift`（或者未填，向下相容）嘅卡先可以做逐更
 * client_rate_snapshot／guard_wage_snapshot／broker_fee_snapshot——
 * `monthly_fixed`／`admin_fee`／`special` 呢類「成個月一筆過」嘅卡（唔理
 * 掛喺 site 級定係更別級）一律唔可以喺呢度（逐更 resolver）被揀中，否則
 * 會將成個月嘅總額（例如 Event Guard $11,700）誤當單更價寫入某一條
 * shift_record（7 月 seed 對呢類記錄嘅 snapshot 刻意留 null，見
 * gate:pricing）。 */
function isPerShiftEligible(card: RateCardLite): boolean {
  return card.billingModel === null || card.billingModel === "per_shift";
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
 * （呢張卡根本唔適用）。`opts.ignoreBroker`（gate:pricing 對 7 月數據
 * 逐條驗證證實嘅口徑）：收客价（client_rate）本質上係「呢個盤呢個更別」
 * 嘅價，唔係「邊個雞頭」嘅價——雞頭專属嘅收客价卡（例：啟航1331 D 更
 * 掛咗喺 K 雞頭嘅 $1200 卡）其實係成個更別嘅標準收客价，7 月數據入面
 * 唔理實際結算雞頭係邊個（K／B07／Y……）都套用同一個收客价。所以出街价
 * （guard_wage/broker_fee）先要求 broker 一定要夾，收客价搵唔到夾嘅
 * broker 就擴大搜尋（`ignoreBroker:true`，見 resolveShiftPricingFromCards
 * 兩段式揀 clientCard）唔理張卡本身掛咗邊個雞頭。
 *   0：guard 专属 + 同 shift_type
 *   1：guard 专属（shift_type 通用）
 *   2：雞頭专属 + 同 shift_type
 *   3：雞頭专属（shift_type 通用）
 *   4：通用（site 级）+ 同 shift_type
 *   5：通用（site 级 flat 卡，shift_type 都通用）
 */
function specificityRank(
  card: RateCardLite,
  ctx: { shiftTypeId: string; settlementBrokerId: string | null; guardId: string; requireExactShiftType?: boolean },
  opts?: { ignoreBroker?: boolean },
): number | null {
  const guardMatches = card.guardId === null || card.guardId === ctx.guardId;
  // gate:pricing 對 7 月數據驗證：guard 专属卡（guardId 有值）嘅
  // broker_id 唔可以做「夾唔夾」嘅硬性條件——guard 专属卡本質係「呢個人
  // 嘅價」，張卡本身掛住邊個雞頭（介紹/建檔嗰個雞頭）淨係 provenance，
  // 唔代表淨係嗰個雞頭幫呢個人結算先算數（實證：長工掛喺 B07 名下
  // 結算，但佢張純介紹費卡本身掛住 T，一樣要夾中）。broker 专属（冇
  // guardId）嘅卡就照舊要求 broker 一定要夾，或者經 `opts.ignoreBroker`
  // 兩段式 fallback（見 clientCard／resolvePayoutFromCards 揀卡）。
  const brokerMatches = card.guardId !== null || opts?.ignoreBroker || card.brokerId === null || card.brokerId === ctx.settlementBrokerId;
  // gate:pricing 對 7 月數據驗證：code="PR"（糧明細生成 reconciliation
  // placeholder）更別唔可以夾 shift_type_id=null 嘅泛用卡——見
  // `ResolveShiftPricingInput.shiftTypeCode`／`requireExactShiftTypeMatch()`。
  const shiftTypeMatches = ctx.requireExactShiftType ? card.shiftTypeId === ctx.shiftTypeId : card.shiftTypeId === null || card.shiftTypeId === ctx.shiftTypeId;
  if (!guardMatches || !brokerMatches || !shiftTypeMatches) return null;

  if (card.guardId !== null) return card.shiftTypeId !== null ? 0 : 1;
  if (card.brokerId !== null) return card.shiftTypeId !== null ? 2 : 3;
  return card.shiftTypeId !== null ? 4 : 5;
}

function pickBestCard(
  cards: RateCardLite[],
  ctx: { shiftTypeId: string; settlementBrokerId: string | null; guardId: string; workDate: Date; requireExactShiftType?: boolean },
  predicate: (c: RateCardLite) => boolean,
  opts?: { ignoreBroker?: boolean },
): RateCardLite | null {
  let best: RateCardLite | null = null;
  let bestRank = Infinity;
  for (const card of cards) {
    if (!predicate(card)) continue;
    if (!isEffectiveOn(card, ctx.workDate)) continue;
    const rank = specificityRank(card, ctx, opts);
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
    billingModel: r.billingModel,
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

  const ctx = {
    shiftTypeId: input.shiftTypeId,
    settlementBrokerId: input.settlementBrokerId,
    guardId: input.guardId,
    workDate: input.workDate,
    requireExactShiftType: requireExactShiftTypeMatch(input.shiftTypeCode),
  };
  const source: ResolvedShiftPricing["source"] = {};

  // ---- external（gate:pricing 對 7 月數據驗證推翻咗原本「external 都要
  // 计收客价」嘅假設）：external＝客戶自己嘅人（例如數碼港 Wilson Guard/
  // Supervisor），公司根本唔開單俾客戶（monthly-close.ts 都成行剔走），
  // 7 月 286 條 external 記錄 client_rate_snapshot 100% 係 null——收客价／
  // 出街价一律 null，唔计任何卡。
  const isExternal = input.isExternal || input.brokerKind === "external";
  if (isExternal) {
    return { clientRate: null, guardWage: null, brokerFee: null, source, unpriced: false, reason: "external" };
  }

  // ---- 收客价：长工都要计（收入照計）--------------------------------
  // M1（Opus 驗收）：淨係 per_shift（或者未填 billing_model，向下相容）
  // 嘅卡先可以做逐更 client_rate_snapshot——月費／admin_fee／special 嘅
  // 「成個月總額」卡（唔理掛喺 site 級定更別級）一律唔可以喺呢度被揀中。
  // 兩段式揀卡（gate:pricing 驗證）：先試「同結算雞頭夾」，夾唔到（例如
  // 呢個更別嘅收客价卡掛咗喺另一個雞頭度，但收客价本質上係成個更別嘅
  // 標準價）先擴大做 `ignoreBroker:true`（唔理張卡掛咗邊個雞頭）。
  const clientPredicate = (c: RateCardLite) => c.clientRate !== null && isPerShiftEligible(c);
  const clientCard = pickBestCard(cards, ctx, clientPredicate) ?? pickBestCard(cards, ctx, clientPredicate, { ignoreBroker: true });
  const clientRate = clientCard ? clientCard.clientRate : null;
  if (clientCard) source.clientCardId = clientCard.id;

  // gate:pricing 對 7 月數據驗證推翻咗「longterm 出街价一律 null」嘅
  // 假設：長工掛喺個別雞頭（例如 B07）名下，雞頭有時仍然收一筆純介紹費
  // （broker_fee 有值、guard_wage 保持 null——長工本身月薪 autopay，唔
  // 經呢張卡出糧），要照跑落面嘅出街价 payout 揀卡（同正常路徑一樣），
  // 搵唔到卡先至當「冇出街价」（unpriced 依然 false——longterm 本身
  // 「冇出街价」屬正常，唔係缺价）。
  if (input.brokerKind === "internal_longterm") {
    const payout = resolvePayoutFromCards(cards, ctx);
    if (payout) source.payoutCardId = payout.cardId;
    return { clientRate, guardWage: payout?.guardWage ?? null, brokerFee: payout?.brokerFee ?? null, source, unpriced: false, reason: "longterm" };
  }
  if (!input.settlementBrokerId) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true, reason: "no_broker" };
  }

  const payout = resolvePayoutFromCards(cards, ctx);
  if (!payout) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true };
  }
  source.payoutCardId = payout.cardId;
  return { clientRate, guardWage: payout.guardWage, brokerFee: payout.brokerFee, source, unpriced: false };
}

/**
 * S2 出街价取值規則（gate:pricing 對 7 月數據逐條驗證）——淨係 per_shift
 * 嘅卡先可以做逐更 guard_wage_snapshot／broker_fee_snapshot：
 *   guard_wage 有值 → wage=guard_wage、fee=broker_fee（唔補算）——gate:
 *     pricing 逐條驗證推翻咗「payout_rate−guard_wage 反推 fee」呢個假設：
 *     guard 专属卡好多時 payout_rate 純粹等於 guard_wage（冇拆開嘅歷史
 *     欄位遺留），逐差得出嘅 0 同 7 月實際 broker_fee_snapshot=null 唔
 *     一致；broker_fee 冇值就係 null，唔會由 payout_rate 反推；
 *   guard_wage null 而 broker_fee 有值（純介紹費卡，例如雞頭轉介費，
 *     長工掛喺個別雞頭名下最常見）→ wage=null、fee=broker_fee（唔准將
 *     雞頭費當工資）；
 *   兩者都 null 而 payout_rate 有值 → wage=payout_rate、fee=0（7 月
 *     W/G/D「合計」snapshot 口徑，未拆分嘅卡）。
 */
function resolvePayoutFromCards(
  cards: RateCardLite[],
  ctx: { shiftTypeId: string; settlementBrokerId: string | null; guardId: string; workDate: Date; requireExactShiftType?: boolean },
): { cardId: string; guardWage: number | null; brokerFee: number | null } | null {
  const payoutCard = pickBestCard(cards, ctx, (c) => isPerShiftEligible(c) && (c.guardWage !== null || c.brokerFee !== null || c.payoutRate !== null));
  if (!payoutCard) return null;

  let guardWage: number | null;
  let brokerFee: number | null;
  if (payoutCard.guardWage !== null) {
    guardWage = payoutCard.guardWage;
    brokerFee = payoutCard.brokerFee; // 冇值就係 null，唔由 payout_rate 反推（見上面註解）
  } else if (payoutCard.brokerFee !== null) {
    // 純介紹費卡（guard_wage null）：唔准將雞頭費當工資，wage 保持 null。
    guardWage = null;
    brokerFee = payoutCard.brokerFee;
  } else {
    // predicate 保證 payoutRate !== null（guardWage/brokerFee 皆 null）
    guardWage = payoutCard.payoutRate as number;
    brokerFee = 0;
  }

  return { cardId: payoutCard.id, guardWage, brokerFee };
}

/** 方便單條記錄用（POST /api/shift-records、approve 補計）——內部自己攞一次卡（唔係 batch，一次一條可以接受）。 */
export async function resolveShiftPricing(input: ResolveShiftPricingInput): Promise<ResolvedShiftPricing> {
  const day = input.workDate;
  const cards = await fetchEffectiveRateCards(input.siteId, day, day);
  return resolveShiftPricingFromCards(cards, input);
}

function toNumberLike(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "toString" in v) {
    const num = Number((v as { toString(): string }).toString());
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

/**
 * 「未定价」定義（規劃裁定，WP-PRICE §3；S3 擴大）：record_type=shift、非
 * cancelled、broker kind 唔係 internal_longterm／external（呢兩類
 * wage/fee=null 屬正常，唔算未定价）——**出街价未定**（payout_unpriced）：
 * broker_fee_snapshot 係 null，而且 guard_wage_snapshot 係 null 或者 0
 * （S3：`wage=0 且 fee=null` 都算未定价，唔止兩者皆 null 先算）。
 */
export function isUnpricedShift(
  record: { recordType: string; status: string; guardWageSnapshot: unknown; brokerFeeSnapshot: unknown },
  brokerKind: BrokerKindLike,
): boolean {
  if (record.recordType !== "shift") return false;
  if (record.status === "cancelled") return false;
  if (brokerKind === "internal_longterm" || brokerKind === "external") return false;
  const feeNull = record.brokerFeeSnapshot === null || record.brokerFeeSnapshot === undefined;
  const wage = toNumberLike(record.guardWageSnapshot);
  const wageNullOrZero = wage === null || wage === 0;
  return feeNull && wageNullOrZero;
}

/**
 * S3：**收客价未定**（client_unpriced）——淨係逐更盤（site billing_model=
 * per_shift）先算：client_rate_snapshot 係 null。月費／admin_fee／special
 * 等非逐更盤，收客价本身就唔係逐更計，client_rate_snapshot=null 屬正常，
 * 唔算未定价。
 */
export function isClientUnpricedShift(
  record: { recordType: string; status: string; clientRateSnapshot: unknown },
  siteBillingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special" | string,
): boolean {
  if (record.recordType !== "shift") return false;
  if (record.status === "cancelled") return false;
  if (siteBillingModel !== "per_shift") return false;
  return record.clientRateSnapshot === null || record.clientRateSnapshot === undefined;
}
