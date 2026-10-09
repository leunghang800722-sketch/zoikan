// WP-ONE-CLICK-AUTO（§31）：共用型別。
// 鐵則：報告／分診題以外唔准出 PII——呢度所有 summary／title 淨係盤名、雞頭代號、更種代號、數目。

/** 自動改動流水帳（month_close_auto_changes.kind）。 */
export type AutoChangeKind =
  | "site_alias"
  | "site_created"
  | "shift_type_created"
  | "rate_card_created"
  | "price_snapshots"
  | "settlement_set"
  | "guard_alias_added"
  | "guard_staffno_added";

export const MC_KINDS = [
  "month_close_site_alias",
  "month_close_site_new",
  "month_close_pricing",
  "month_close_settlement",
  "month_close_guard_match",
  "month_close_shift_variance",
] as const;
export type McKind = (typeof MC_KINDS)[number];

export const MC_KIND_LABEL: Record<McKind, string> = {
  month_close_site_alias: "更表盤名似現有盤",
  month_close_site_new: "新盤冇價可推",
  month_close_pricing: "未定價（有候選／冇依據）",
  month_close_settlement: "冇結算雞頭",
  month_close_guard_match: "安員配對要核實",
  month_close_shift_variance: "更數差異解釋唔到",
};

export interface PricingGroupRef {
  siteId: string;
  shiftTypeId: string;
  /** null＝冇結算雞頭。 */
  brokerId: string | null;
  /** 是否 OT 更（record_type=ot）。 */
  ot: boolean;
}

export interface PriceValues {
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
  payoutRate: number | null;
}

export type McAction =
  | { type: "site_alias"; uploadId: string; siteNameRaw: string }
  | { type: "site_new"; siteId: string; groups: PricingGroupRef[] }
  | { type: "pricing"; group: PricingGroupRef; needClient: boolean; needPayout: boolean; count: number }
  | { type: "settlement"; siteId: string; guardId: string; count: number }
  | { type: "guard_match"; identity: { staffNoNorm: string | null; nameRaw: string; telRaw: string | null }; siteLabel: string; cellCount: number }
  | { type: "shift_variance"; siteId: string }
  /** OT 更冇 ot_hours：唔建卡，叫人補時數（淨係可以「我已處理」或跳過）。 */
  | { type: "ot_hours"; group: PricingGroupRef; count: number };

export interface McCandidate {
  /** 答案 `candidate_id` 對應呢個。 */
  id: string;
  label: string;
  /** pricing：候選價；site_alias：盤；settlement：雞頭；guard_match：安員。 */
  values?: PriceValues;
  /** 候選指向嘅 id（siteId／brokerId／guardId）。 */
  refId?: string;
  /** 一句來源證據。 */
  evidence?: string;
}

/** triage_questions.evidence_json（month_close_* 題）。 */
export interface McEvidence {
  v: 1;
  mc: true;
  runId: string;
  month: string;
  kind: McKind;
  /** 一句原因。 */
  summary: string;
  /** 預填建議答案一句（unknown＝null）。 */
  suggestion: string | null;
  confidence: "propose" | "unknown";
  action: McAction;
  candidates: McCandidate[];
  /** 預填候選 id（一撳確認用）。 */
  prefillCandidateId: string | null;
}

export interface McQuestionDraft {
  kind: McKind;
  groupKey: string;
  sort: number;
  title: string;
  evidence: McEvidence;
}

export interface AutoSummary {
  /** 自動加別名對盤（exact＋auto）。 */
  sitesAliased: number;
  sitesCreated: number;
  shiftTypesCreated: number;
  aliasesFromPostorder: number;
  /** 自動建價卡張數／套用到嘅更數。 */
  cardsCreated: number;
  recordsPriced: number;
  /** 自動歸屬結算雞頭更數。 */
  recordsSettled: number;
  guardMatchesAuto: number;
  /** 解釋咗嘅更數異常（盤數）。 */
  variancesExplained: number;
  variancesUnexplained: number;
  /** 未定價更數（auto 之後仍未有價）同分類。 */
  unpricedRecords: number;
  /** 估算缺口：未定價更 × 同盤同更種最近已知客價（只作提示，唔入任何金額表）。 */
  unpricedClientGapEstimate: number | null;
  unpricedPayoutGapEstimate: number | null;
  /** 客戶自己人（external）／公司兵／一般更數（shift_records，非 cancelled，recordType=shift）。 */
  counts: { countable: number; external: number; internalCash: number };
}

export function emptyAutoSummary(): AutoSummary {
  return {
    sitesAliased: 0,
    sitesCreated: 0,
    shiftTypesCreated: 0,
    aliasesFromPostorder: 0,
    cardsCreated: 0,
    recordsPriced: 0,
    recordsSettled: 0,
    guardMatchesAuto: 0,
    variancesExplained: 0,
    variancesUnexplained: 0,
    unpricedRecords: 0,
    unpricedClientGapEstimate: null,
    unpricedPayoutGapEstimate: null,
    counts: { countable: 0, external: 0, internalCash: 0 },
  };
}

export interface AutoItemLine {
  kind: AutoChangeKind | "guard_match" | "variance" | "pricing";
  /** 一句（盤名／代號／數目，冇 PII）。 */
  text: string;
}

export interface ReviewItem {
  kind: McKind;
  /** 一句原因。 */
  text: string;
  confidence: "propose" | "unknown";
  /** 對應分診題 id（建咗題先有）。 */
  questionId: string | null;
}

export interface AutoReport {
  summary: AutoSummary;
  /** 自動做咗乜（逐項一句，最多 80 項）。 */
  autoLines: AutoItemLine[];
  /** 要你睇（propose／unknown，每項一句原因）。 */
  review: ReviewItem[];
  triageSessionId: string | null;
  undone: boolean;
  undoneAt: string | null;
  /** undo 安全網：價錢同已作廢 auto 卡相同但冇自動定價紀錄嘅更（只報數，唔清）；recordIds 最多 50 個。 */
  voidedCardPriceCheck?: { count: number; recordIds: string[] };
}
