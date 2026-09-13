// P1-WP4：雞頭費拆分（老闆 2026-09-13 批准；P0 §3.5「出街價＝保安員工資＋
// 雞頭費」定義，源頭糧明細／總表只有出街價合計，冇拆開）。
//
// 正式庫已經用一次性腳本拆咗（B01=K，47 張合計卡、974 條 7 月合計
// snapshot：出街價／總數不變，guard_wage = payout − fee，broker_fee =
// fee）。呢個純函數淨係做「一張合計卡／一條合計 snapshot ＋ 適用嘅雞頭
// 費率 → 拆開」呢一步，唔碰 DB／CSV I/O，等 seed（rate_cards 同
// shift_records 快照 stamping 兩處都要用）同單元測試（見
// tests/seed-broker-fee-split.test.ts）可以共用同一份邏輯，唔會兩處各
// 寫一份而慢慢分岔。
//
// 「合計卡／合計 snapshot」嘅判斷準則（規劃裁定）：
// - broker.kind === "broker"（外判雞頭）——長工/公司兵/external 唔屬呢類，唔拆。
// - 呢個 broker（broker_csv_id）喺 brokerFeeRules 有登記——冇規則嘅雞頭唔動。
// - guardWage 有值——null（例如冇對應價卡／冇 snapshot）唔拆，冇嘢好拆。
// - brokerFee 係 null 或 0——已經拆開咗嘅卡／記錄（brokerFee 已經有正數）
//   唔會再拆一次，保證呢個函數 idempotent（可以安全喺已經拆過嘅庫上再跑一次 seed）。
//
// 拆法：fee = bySite[siteCanonicalName] ?? default；
//       newGuardWage = guardWage − fee；newBrokerFee = fee。
// 出街價（guardWage + brokerFee 之和）保持不變。

export interface BrokerFeeRule {
  default: number;
  bySite?: Record<string, number>;
}

export type BrokerFeeRules = Record<string, BrokerFeeRule>;

export interface BrokerFeeSplitInput {
  /** rate_cards.csv / shift_records.csv 嘅 broker_csv_id（例如 "B01"）—— 對於 shift_records 用嘅係 settlement broker 嗰個。 */
  brokerCsvId: string | null;
  /** 呢個 broker 嘅 kind（"broker"／"internal_cash"／"internal_longterm"／"external"／"special"）。 */
  brokerKind: string | null;
  /** 呢張卡／呢條記錄所屬盤嘅 canonical_name。 */
  siteCanonicalName: string | null;
  guardWage: number | null;
  brokerFee: number | null;
}

export interface BrokerFeeSplitResult {
  guardWage: number | null;
  brokerFee: number | null;
  /** 呢次有冇實際拆分（false = 原封不動，因為唔合資格）。 */
  split: boolean;
}

export function applyBrokerFeeSplit(rules: BrokerFeeRules, input: BrokerFeeSplitInput): BrokerFeeSplitResult {
  const { brokerCsvId, brokerKind, siteCanonicalName, guardWage, brokerFee } = input;
  const unchanged: BrokerFeeSplitResult = { guardWage, brokerFee, split: false };

  if (brokerKind !== "broker") return unchanged; // 長工/公司兵/external 唔動
  if (!brokerCsvId) return unchanged;
  const rule = rules[brokerCsvId];
  if (!rule) return unchanged; // 冇規則嘅雞頭唔動
  if (guardWage === null) return unchanged; // 冇對應價，冇嘢好拆
  if (brokerFee !== null && brokerFee !== 0) return unchanged; // 已經拆開／本身已有雞頭費，唔再拆（idempotent）

  const fee = (siteCanonicalName ? rule.bySite?.[siteCanonicalName] : undefined) ?? rule.default;
  return { guardWage: guardWage - fee, brokerFee: fee, split: true };
}
