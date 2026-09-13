// P1-WP4：一次性補漏卡（2026-09-13 老闆質詢後跟進）。
//
// 背景：殷樺花園（S001）雞頭 K（B01）7 月 25 條更次（source=
// master_roster_site，settlement_page=總表確認-K）由頭到尾冇任何 K 嘅
// rate_cards 卡——唔係「有卡但價錯」，係「連卡都冇」，令
// shift_records_priced.csv／DB 嘅 guard_wage_snapshot 一直留空、呢 25 更
// 靜靜哋變咗 $0 成本（P0 自己嘅糧明細/月結都冇計過）。P0 在勤總表
// （tools/importer/out/wp5/master_posts.csv，property=殷樺，block「城巴
// 車廠 12hrs (N/S)」Night）其實有呢個崗位嘅外判價 850，只係冇轉做
// rate_cards 卡。
//
// 呢個 module 由 seed-overrides.json 嘅 extraRateCards（見
// lib/seed-overrides.ts）建構出同 CSV.rateCards 同一形狀嘅 row，等
// seedRateCards()／seedShiftRecords() 兩處可以將佢當普通 CSV 卡一樣處理
// （包括經 lib/broker-fee-split.ts 自動拆 guard_wage/broker_fee）。
//
// 實際套用嘅 shift_type_id 唔喺 override JSON 手動指定——而係喺呢度
// 反推：搵返呢個 site+broker 組合入面邊啲「正更、未 out_of_scope、
// guard_wage_snapshot 同 broker_fee_snapshot 都係空」嘅更次，攞佢哋嘅
// shift_type_id。呢個做法保證補漏卡精準命中真正缺價嘅更型，唔會人手
// 估漏，亦都保證吃唔到已經有卡嘅更次（唔會意外覆蓋現有價）。
import { readCsv, num, bool } from "./csv";
import { CSV } from "./paths";
import { settlementUnitToBrokerCsvId } from "./mapping";
import type { ExtraRateCardOverride } from "./seed-overrides";

export interface ExtraRateCardRow {
  rate_id: string;
  site_id: string;
  shift_type_id: string;
  broker_id: string;
  guard_id: string;
  client_rate: string;
  guard_wage: string;
  broker_fee: string;
  payout_rate: string;
  billing_model: string;
  effective_from: string;
  effective_to: string;
  source: string;
  evidence: string;
  confidence: string;
  status: string;
  note: string;
}

export function resolveExtraRateCardRows(
  overrides: ExtraRateCardOverride[],
  siteCsvIdByCanonicalName: Map<string, string>,
): ExtraRateCardRow[] {
  if (overrides.length === 0) return [];

  type ShiftRow = {
    shift_id: string;
    site_id: string;
    shift_type_id: string;
    settlement_unit: string;
    record_type: string;
    out_of_scope: string;
  };
  type PricedRow = { shift_id: string; guard_wage_snapshot: string; broker_fee_snapshot: string };

  const shiftRows = readCsv<ShiftRow>(CSV.shiftRecords);
  const pricedByShiftId = new Map(readCsv<PricedRow>(CSV.shiftRecordsPriced).map((p) => [p.shift_id, p]));
  const settlementUnitMap = settlementUnitToBrokerCsvId();

  const out: ExtraRateCardRow[] = [];
  overrides.forEach((o, i) => {
    const siteCsvId = siteCsvIdByCanonicalName.get(o.site);
    if (!siteCsvId) {
      throw new Error(`extraRateCards[${i}]：搵唔到盤「${o.site}」對應嘅 site_id（sites.csv 冇呢個 canonical_name，可能打錯字或者個盤重命名咗）`);
    }

    const gapShiftTypeIds = new Set<string>();
    for (const r of shiftRows) {
      if (r.site_id !== siteCsvId) continue;
      if (r.record_type !== "shift") continue;
      if (bool(r.out_of_scope)) continue;
      if (settlementUnitMap[r.settlement_unit] !== o.broker_csv_id) continue;
      const priced = pricedByShiftId.get(r.shift_id);
      const guardWageSnapshot = priced ? num(priced.guard_wage_snapshot) : null;
      const brokerFeeSnapshot = priced ? num(priced.broker_fee_snapshot) : null;
      if (guardWageSnapshot !== null || brokerFeeSnapshot !== null) continue; // 已經有價，唔關呢張補漏卡事
      gapShiftTypeIds.add(r.shift_type_id);
    }
    if (gapShiftTypeIds.size === 0) {
      throw new Error(
        `extraRateCards[${i}]：broker=${o.broker_csv_id} site=${o.site}（${siteCsvId}）搵唔到任何缺價嘅 shift_type——呢張補漏卡可能已經冇用（P0 源頭數據換咗版本？），需要人手覆核先可以刪走呢個 override。`,
      );
    }
    let n = 0;
    for (const shiftTypeId of gapShiftTypeIds) {
      n++;
      out.push({
        rate_id: `EXTRA${String(i).padStart(3, "0")}-${n}`,
        site_id: siteCsvId,
        shift_type_id: shiftTypeId,
        broker_id: o.broker_csv_id,
        guard_id: "",
        client_rate: o.client_rate != null ? String(o.client_rate) : "",
        // 合計卡：guard_wage=payout_rate、broker_fee 留空，等
        // brokerFeeRules（見 lib/broker-fee-split.ts）自動拆開，同
        // rate_cards.csv 入面其他未拆嘅雞頭卡格式一致。
        guard_wage: String(o.payout_rate),
        broker_fee: "",
        payout_rate: String(o.payout_rate),
        billing_model: "per_shift",
        effective_from: o.effective_from,
        effective_to: o.effective_to ? o.effective_to : "",
        source: o.source ?? "",
        evidence: "",
        confidence: "high",
        status: "solved",
        note: o.note ?? "",
      });
    }
  });
  return out;
}
