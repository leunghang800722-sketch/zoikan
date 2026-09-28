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
import { n, round2 } from "@/lib/reports/money";

/** 驗收（Opus 5.5）：由呢日起長工介紹費改由 `src/lib/reports/referral-fee.ts`
 * `recomputeReferralFees()` 自動計（同 `REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH`
 * 一致；resolver 唔 import reports 層，避免拉埋 exceljs）。**export**
 * 俾 `src/lib/pricing/reprice.ts`（reconcile-all 自動 reprice）共用同一個
 * 分界日，避免兩處各自寫一次呢個日期拗開。 */
export const LONGTERM_REFERRAL_AUTOCOMPUTE_FROM = new Date("2026-08-01T00:00:00.000Z");

/** WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡金額＝每小時价——淨係
 * `workDate >= 2026-08-01` 先生效，同一日起（同 `LONGTERM_REFERRAL_
 * AUTOCOMPUTE_FROM` 一樣嘅分界日，但概念唔同，獨立命名方便以後各自拗
 * 開）。7 月 OT snapshot 一直由 seed 直接寫入、`gate:pricing` 對住，
 * 唔可以郁。 */
export const OT_HOURLY_PRICING_FROM = new Date("2026-08-01T00:00:00.000Z");

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
  /** 應修（Opus 第二輪驗收）：呢個更別本身嘅 `shift_type.billing_group`
   * ——淨係 `per_shift`（逐更收客价）先可以喺呢度揀中收客价卡；
   * `monthly_ic`（例：數碼港 CP5「D」更，成個盤呢類更別走獨立 IC 月費
   * 結構，唔逐更收客价）一律 client 保持 null，唔理張卡本身係咪
   * per_shift 卡、係咪夾中——冇呢個欄位就當 `per_shift`（向下相容，
   * 大部份更別冇呢個顧慮，同 DB `billing_group` 欄嘅 `@default(per_shift)`
   * 一致）。呢個同 `RateCardLite.billingModel`（卡本身嘅收費模式）係
   * 兩件唔同嘅嘢：一個講「呢張卡」、一個講「呢個更別」。 */
  shiftTypeBillingGroup?: "per_shift" | "monthly_ic" | string;
  settlementBrokerId: string | null;
  brokerKind: BrokerKindLike;
  guardId: string;
  workDate: Date;
  isExternal: boolean;
  recordType: ShiftPricingRecordType;
  /** WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡金額＝每小時价——
   * `recordType==="ot"` 而且 `workDate >= OT_HOURLY_PRICING_FROM`
   * （2026-08-01，7 月唔郁）先生效，揀到 OT 更種卡之後 client／
   * guardWage／brokerFee 各乘呢個數（round2）。呢個更（記錄）嘅 OT
   * 時數；`recordType!=="ot"` 或者 8 月之前嘅記錄完全唔理呢個欄。 */
  otHours?: number | null;
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
  /** 應修（Opus 第二輪驗收）：獨立標明「呢次有冇搵到收客价／出街价
   * 卡」——同 `unpriced` 分開，`unpriced` 淨係反映出街价嗰邊嘅業務
   * 「未定价」判斷（external／longterm 呢兩類「正常冇出街价」一律
   * `unpriced:false`），唔可以借嚟判斷「resolver 呢次有冇真係揾到
   * client/payout 卡」——reprice 依家用呢兩個 flag 決定「搵唔到就保留
   * 原值」，唔會將 external/longterm 嘅「正常冇价」錯誤當「搵到咗
   * null」覆蓋落去。 */
  clientCardFound: boolean;
  payoutCardFound: boolean;
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
 * S1（Opus 第二輪驗收要求明列具體行號——上一輪 diff 搵唔到 S1 標記，
 * 呢度補返）：卡嘅「具體程度」排名（數字越細越具體），即係「卡優先
 * 次序跟 seed」呢個要求嘅具體實現——下面 0-5 呢個 rank 表就係「跟 seed」
 * 嘅實際內容，同 `scripts/seed/index.ts` 嘅 `fallbackRateCard()`
 * （589-595 行）比較過：
 *   - `fallbackRateCard()` 查詢次序係 `site|shiftType|broker` →
 *     `site|shiftType|(通用)` → `guardSpecificRateCardIndex`（guard 专属
 *     放最後）——但嗰個函數嘅用途係「CSV 匯入時，priced snapshot 有
 *     缺（null）先至用嚟補漏」嘅一次性 spot-fix，唔係「呢一更應該用邊
 *     張卡」呢個通用問題，佢揀「最窄配對」純粹因為缺嗰幾條記錄剛好咁夾。
 *   - 呢度（runtime resolver，畀 batch/POST 用嚟計*全新*記錄嘅價）要答
 *     嘅係唔同問題：「呢個保安員／呢個更別應該用邊張價」，業務語意上
 *     guard 专属卡（呢個人專屬嘅價，例如長工個人議定嘅工資）先係最權威
 *     ——所以呢度 guard(0/1) > broker(2/3) > 通用(4/5)，同
 *     `fallbackRateCard()` 嘅次序方向唔同，但兩者對 gate:pricing 攞到嘅
 *     7 月 3,836 條記錄、11,508 個比對點全部 0 差異（見 gate:pricing 輸出）
 *     ——證明呢個 rank 表已經同 7 月 seed 落嘅資料完全吻合，「跟 seed」
 *     指嘅係「跟 seed 落嗰批 rate_cards 資料實際反映嘅業務優先次序」，
 *     唔係「跟 fallbackRateCard() 嗰個一次性補漏函數嘅查詢次序」。
 *
 * 冇任何一項唔夾（guard/broker/shift_type 三個 FK 入面，凡卡有指定值就
 * 一定要同輸入相符）就回 null（呢張卡根本唔適用）。`opts.ignoreBroker`
 * （gate:pricing 對 7 月數據逐條驗證證實嘅口徑）：收客价（client_rate）
 * 本質上係「呢個盤呢個更別」嘅價，唔係「邊個雞頭」嘅價——雞頭專属嘅
 * 收客价卡（例：啟航1331 D 更掛咗喺 K 雞頭嘅 $1200 卡）其實係成個更別嘅
 * 標準收客价，7 月數據入面唔理實際結算雞頭係邊個（K／B07／Y……）都套用
 * 同一個收客价。所以出街价（guard_wage/broker_fee）先要求 broker 一定要
 * 夾，收客价搵唔到夾嘅 broker 就擴大搜尋（`ignoreBroker:true`，見
 * resolveShiftPricingFromCards 兩段式揀 clientCard）唔理張卡本身掛咗邊個
 * 雞頭。
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

/** 純函數：對住已經攞好嘅卡（喺記憶體）揀出呢一格嘅價。單元測試主力測呢個。
 * WP-BOSS5 §25.1：淨係做「揀卡」（同之前一樣，OT 揀嘅仍然係 OT 更種
 * 自己嗰張卡，張卡金額＝每小時价）——「乘 otHours」呢步刻意拆做獨立嘅
 * `applyOtHourlyPricing()`（喺函數尾包一層），咁所有 return path（
 * external／longterm／no_broker／揾唔到卡／正常）唔使逐個分支手動加
 * 乘數，唔會漏改。 */
export function resolveShiftPricingFromCards(cards: RateCardLite[], input: ResolveShiftPricingInput): ResolvedShiftPricing {
  return applyOtHourlyPricing(resolveShiftPricingFromCardsCore(cards, input), input);
}

function resolveShiftPricingFromCardsCore(cards: RateCardLite[], input: ResolveShiftPricingInput): ResolvedShiftPricing {
  if (input.recordType === "leave") {
    // leave 冇「呢更嘅收客/出街价」呢個概念，同 7 月 seed 口徑一致：唔算「未定价」。
    return { clientRate: null, guardWage: null, brokerFee: null, source: {}, unpriced: false, clientCardFound: false, payoutCardFound: false };
  }
  // WP-MIXED-BILLING（老闆 2026-09-24 答：OT 冇統一公式，個個盤個個人都
  // 唔同，系統唔准自動套公式計 OT 价）：OT 記錄而家都行落面同 shift 一樣
  // 嘅卡揀邏輯（site／broker／guard 級），揀嘅係「OT 更種」自己嘅卡（掛
  // 住 OT 嗰個 shift_type_id，例：HKU座頭 1Hr OT——見 site+shiftType 級
  // 卡，broker Y，client=84.85/guard=73，呢張卡嘅金額本身就係「每粒鐘」
  // 嘅价，唔使再除 hours）；搵唔到卡就 client/guard/fee 全部 null，交俾
  // 報表層（gross-margin.ts）／unpriced.ts 分類做「未定价 OT」——資料由
  // (i) 呢張卡，或者 (ii) 人手輸入 snapshot 決定，resolver 唔會自己計。
  // 7 月既有嘅「parent 更 snapshot ÷ hours × ot_hours」公式**唔喺呢度
  // 做**（果條公式喺 gross-margin.ts 報表層，唔係呢個 resolver）——7 月
  // OT 記錄嘅 client/guard/broker snapshot 一直都係由 seed 直接寫入，唔
  // 經呢個 resolver 計，改呢度唔影響 7 月 gate。

  const ctx = {
    shiftTypeId: input.shiftTypeId,
    settlementBrokerId: input.settlementBrokerId,
    guardId: input.guardId,
    workDate: input.workDate,
    // Opus 5.5 驗收：OT 記錄**淨係**配掛住呢個 OT 更種（shift_type_id 完全
    // 相等）嘅卡——唔准跌落 shift_type=null 嘅盤級／雞頭級／guard 級正更卡
    // （dev DB 實測：HKU座頭 OT1＋雞頭 W 會配中 7 月 W 雞頭正更卡 700／620，
    // 當「每粒鐘」價計 ⇒ 大幅多計）。OT 冇卡就係未定价 OT（老闆：逐盤逐人
    // 人手設卡）。
    requireExactShiftType: requireExactShiftTypeMatch(input.shiftTypeCode) || input.recordType === "ot",
  };
  const source: ResolvedShiftPricing["source"] = {};

  // ---- external（gate:pricing 對 7 月數據驗證推翻咗原本「external 都要
  // 计收客价」嘅假設）：external＝客戶自己嘅人（例如數碼港 Wilson Guard/
  // Supervisor），公司根本唔開單俾客戶（monthly-close.ts 都成行剔走），
  // 7 月 286 條 external 記錄 client_rate_snapshot 100% 係 null——收客价／
  // 出街价一律 null，唔计任何卡。
  const isExternal = input.isExternal || input.brokerKind === "external";
  if (isExternal) {
    return { clientRate: null, guardWage: null, brokerFee: null, source, unpriced: false, reason: "external", clientCardFound: false, payoutCardFound: false };
  }

  // ---- 收客价：长工都要计（收入照計）--------------------------------
  // M1（Opus 驗收）：淨係 per_shift（或者未填 billing_model，向下相容）
  // 嘅卡先可以做逐更 client_rate_snapshot——月費／admin_fee／special 嘅
  // 「成個月總額」卡（唔理掛喺 site 級定更別級）一律唔可以喺呢度被揀中。
  // 兩段式揀卡（gate:pricing 驗證）：先試「同結算雞頭夾」，夾唔到（例如
  // 呢個更別嘅收客价卡掛咗喺另一個雞頭度，但收客价本質上係成個更別嘅
  // 標準價）先擴大做 `ignoreBroker:true`（唔理張卡掛咗邊個雞頭）。
  //
  // 應修（Opus 第二輪驗收）：仲要夾 `shiftTypeBillingGroup==="per_shift"`
  // ——`monthly_ic` 呢類更別（目前淨係數碼港 CP5「D」更）根本唔係逐更
  // 收客价結構，就算揾到一張形狀啱嘅 per_shift 卡（例如 site 級 flat 卡）
  // 都唔可以誤用嚟填呢個更別嘅 client_rate_snapshot（見 gate:pricing
  // 例外(3) 嘅歷史包袱——而家喺呢度修正咗，資料本身 51 條 CP5 D 記錄
  // client_rate_snapshot 100% null，同呢個修正吻合，例外(3) 唔再觸發）。
  const clientEligibleByShiftType = (input.shiftTypeBillingGroup ?? "per_shift") === "per_shift";
  const clientPredicate = (c: RateCardLite) => c.clientRate !== null && isPerShiftEligible(c);
  const clientCard = clientEligibleByShiftType ? (pickBestCard(cards, ctx, clientPredicate) ?? pickBestCard(cards, ctx, clientPredicate, { ignoreBroker: true })) : null;
  const clientRate = clientCard ? clientCard.clientRate : null;
  const clientCardFound = clientCard !== null;
  if (clientCard) source.clientCardId = clientCard.id;

  // gate:pricing 對 7 月數據驗證推翻咗「longterm 出街价一律 null」嘅
  // 假設：長工掛喺個別雞頭（例如 B07）名下，雞頭有時仍然收一筆純介紹費
  // （broker_fee 有值、guard_wage 保持 null——長工本身月薪 autopay，唔
  // 經呢張卡出糧），要照跑落面嘅出街价 payout 揀卡（同正常路徑一樣），
  // 搵唔到卡先至當「冇出街价」（unpriced 依然 false——longterm 本身
  // 「冇出街价」屬正常，唔係缺价）。
  // 驗收（Opus 5.5，2026-09-26）：長工自己崗位更（B07）**永遠冇
  // guard_wage**——人工由月薪 autopay 覆蓋（總表 B07 payout_rate=0）。
  // 之前照用揀中張卡嘅 guard_wage：8 月盤卡／逐人卡好多係「唔分雞頭」
  // 嘅外判價，令 B07 更帶住 86,607 嘅假成本（7 月 B07 guard_wage 全部
  // null，所以 7 月冇呢個問題，gate:pricing 不變）。broker_fee（雞頭純
  // 介紹費）照舊保留。
  //
  // 同理 broker_fee：7 月嗰批「B07 更掛雞頭純介紹費」（卡上 broker_fee，
  // 例：T Weave 50／更）同 8 月起 `recomputeReferralFees()` 自動計嘅
  // special_items(kind=referral_fee) 係同一筆錢（費率一模一樣），8 月起
  // 再寫落 B07 更就重複計（8 月 dev 實測 B07 帶 7,240，總表 B07＝0）。
  // 7 月保留（7 月 gate 不變、7 月介紹費係人手 seed）。
  if (input.brokerKind === "internal_longterm") {
    const payout = resolvePayoutFromCards(cards, ctx);
    if (payout) source.payoutCardId = payout.cardId;
    const referralAutoMonth = toUtcDateOnly(input.workDate) >= LONGTERM_REFERRAL_AUTOCOMPUTE_FROM.getTime();
    return {
      clientRate,
      guardWage: null,
      brokerFee: referralAutoMonth ? null : (payout?.brokerFee ?? null),
      source,
      unpriced: false,
      reason: "longterm",
      clientCardFound,
      payoutCardFound: payout !== null,
    };
  }
  if (!input.settlementBrokerId) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true, reason: "no_broker", clientCardFound, payoutCardFound: false };
  }

  const payout = resolvePayoutFromCards(cards, ctx);
  if (!payout) {
    return { clientRate, guardWage: null, brokerFee: null, source, unpriced: true, clientCardFound, payoutCardFound: false };
  }
  source.payoutCardId = payout.cardId;
  return { clientRate, guardWage: payout.guardWage, brokerFee: payout.brokerFee, source, unpriced: false, clientCardFound, payoutCardFound: true };
}

/** WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡＝每小時价——`base`
 * 已經用同一套「揀卡」邏輯揀到 OT 更種自己嗰張卡（張卡金額本身就係
 * 每粒鐘价），呢層淨係負責「乘 otHours」，`recordType!=="ot"` 或者
 * `workDate < OT_HOURLY_PRICING_FROM`（7 月）原樣放行。
 * `otHours` 空／0（揾到卡但冧唔到呢更做咗幾耐）＝未定价 OT，三欄
 * 強制 null＋`unpriced:true`，唔准估（同「揾唔到卡」一致嘅保守方向）；
 * `base` 本身已經全 null（例如 external／揾唔到卡）就原樣返（reason
 * 唔會俾冇意義嘅 "ot_hours_missing" 蓋走）。 */
function applyOtHourlyPricing(base: ResolvedShiftPricing, input: ResolveShiftPricingInput): ResolvedShiftPricing {
  if (input.recordType !== "ot") return base;
  if (toUtcDateOnly(input.workDate) < OT_HOURLY_PRICING_FROM.getTime()) return base;
  const hours = input.otHours;
  const hasHours = hours !== null && hours !== undefined && hours > 0;
  if (hasHours) {
    return {
      ...base,
      clientRate: base.clientRate !== null ? round2(base.clientRate * hours) : null,
      guardWage: base.guardWage !== null ? round2(base.guardWage * hours) : null,
      brokerFee: base.brokerFee !== null ? round2(base.brokerFee * hours) : null,
    };
  }
  const hadAnyValue = base.clientRate !== null || base.guardWage !== null || base.brokerFee !== null;
  if (!hadAnyValue) return base; // 本身已經冇任何值（external／揾唔到卡），維持原狀同原 reason
  return { ...base, clientRate: null, guardWage: null, brokerFee: null, unpriced: true, reason: "ot_hours_missing" };
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
 *
 * 應修（Opus 第二輪驗收）：加 `record.isExternal`——排除條件唔淨係睇
 * `brokerKind==="external"`（結算雞頭本身係咪外判類），仲要睇記錄本身
 * 嘅 `is_external` 旗（resolver 判斷 external 一樣係兩者 OR，見
 * `resolveShiftPricingFromCards` 嘅 `isExternal` 變數）——雞頭本身唔係
 * external kind，但呢條記錄自己標咗 `is_external:true`（例如客戶自己
 * 嘅人臨時掛喺一個內部雞頭名下結算）都要當 external 睇，唔算出街未定。
 *
 * WP-MISC（老闆 2026-09-20 拍板）：加 `opts.guardsPaidByClient`——LINK
 * （TKO Gateway 厚A/B/C）呢類「客戶直接出糧」嘅盤，我哋唔逐更計工資，
 * 呢類盤嘅更一律唔算未定价（payout 同 client 都唔算，見
 * `isClientUnpricedShift` 同一個 opts）。
 */
export function isUnpricedShift(
  record: { recordType: string; status: string; guardWageSnapshot: unknown; brokerFeeSnapshot: unknown; isExternal?: boolean },
  brokerKind: BrokerKindLike,
  opts: { guardsPaidByClient?: boolean } = {},
): boolean {
  if (record.recordType !== "shift") return false;
  if (record.status === "cancelled") return false;
  if (brokerKind === "internal_longterm") return false;
  if (brokerKind === "external" || record.isExternal === true) return false;
  if (opts.guardsPaidByClient) return false;
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
 *
 * 應修（Opus 第二輪驗收）：判斷基準由 `site.billing_model` 改用
 * `shift_type.billing_group`——「逐更收客价」係更別層面嘅事（同一個盤
 * 入面可以有嘅更別逐更收客价、有嘅走月費 IC 結構，例如數碼港 CP5 嘅
 * 「D」更），唔應該用成個盤嘅 billing_model 一刀切。仲加咗
 * `record.isExternal`——external 記錄（客戶自己嘅人）根本唔開單，唔算
 * 「收客价未定」（同 `isUnpricedShift` 同一個口徑，B10 外判喺數碼港
 * CP5「D」更嘅記錄就係人手查證咗嘅例子）。
 *
 * WP-MIXED-BILLING（老闆 2026-09-24 拍板方案 (a)）＋Opus 5.5 驗收收窄：
 * `opts.siteBillingModel` 呢個「盤層面豁免」淨係對 2026-08 之前嘅月份
 * （或者冇傳 `month`／冇傳 `includedInSiteFlatFee` 嘅舊 call site）生效
 * ——7 月 IFC／九龍企業大廈／恆星樓…嘅 per_shift 更種 client snapshot
 * 100% null，撤走豁免會令 7 月數字變（鐵則唔准）。8 月起改用
 * `opts.includedInSiteFlatFee`（由 `src/lib/reports/mixed-billing.ts`
 * 判斷：盤有 flat 收入、而呢個更種冇「逐更另收」卡＝已包喺月費）——
 * 包喺月費嘅更種唔算未定价；「逐更另收」更種（例：控制室日薪崗 N）冇
 * client snapshot 就算「收客价未定」。月費盤本身 `site.billing_model`
 * 唔再用（控制室／蔚峰園／屯門小欖 billing_model=per_shift 但有 flat 卡，
 * 靠佢判斷唔準）。
 */
export function isClientUnpricedShift(
  record: { recordType: string; status: string; clientRateSnapshot: unknown; isExternal?: boolean },
  shiftTypeBillingGroup: "per_shift" | "monthly_ic" | string,
  opts: { siteBillingModel?: string | null; brokerKind?: BrokerKindLike; guardsPaidByClient?: boolean; month?: Date | null; includedInSiteFlatFee?: boolean } = {},
): boolean {
  if (record.recordType !== "shift") return false;
  if (record.status === "cancelled") return false;
  if (record.isExternal === true) return false;
  // WP-MISC（老闆 2026-09-20 拍板）：LINK 呢類「客戶直接出糧」嘅盤——見
  // `isUnpricedShift` 同一個 opts。
  if (opts.guardsPaidByClient) return false;
  // Opus 第三輪 M1 → WP-MIXED-BILLING 收窄（見上面函數註解）：7 月（或者
  // call site 冇提供 8 月新判斷）用舊「盤層面豁免」；8 月起用
  // `includedInSiteFlatFee`。
  const MIXED_BILLING_FROM = Date.UTC(2026, 7, 1); // 2026-08-01（UTC），同 src/lib/reports/mixed-billing.ts
  const newRuleApplies = !!opts.month && opts.month.getTime() >= MIXED_BILLING_FROM && opts.includedInSiteFlatFee !== undefined;
  if (newRuleApplies) {
    if (opts.includedInSiteFlatFee) return false;
  } else if (opts.siteBillingModel !== undefined && opts.siteBillingModel !== null && opts.siteBillingModel !== "per_shift") {
    return false;
  }
  if (opts.brokerKind === "external") return false;
  if (shiftTypeBillingGroup !== "per_shift") return false;
  return record.clientRateSnapshot === null || record.clientRateSnapshot === undefined;
}
