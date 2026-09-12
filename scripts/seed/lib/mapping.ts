// 業務代碼對照：P0 CSV 用嘅字面值 -> Prisma enum。
// 呢度冇任何真名/電話——淨係代號/枚舉對照，可以安全入 git。
//
// PDPO 裁定（Opus 對抗式驗收）：雞頭真名唔准
// 再喺呢個檔案（git-tracked）硬編碼——搬咗去
// `data/mappings-private/brokers.csv`（gitignored），由
// `settlementUnitToBrokerCsvId()` 呢個 function 喺 runtime 合埋讀入，唔
// 係一個 module-level 嘅 const object 直接暴露晒啲真名喺 source code。
import type { BrokerKind, SettlementType, BillingModel, EmploymentType } from "@prisma/client";
import { settlementUnitAliasMap } from "./broker-names";

export function mapBrokerKind(v: string): BrokerKind {
  switch (v) {
    case "broker":
      return "broker";
    case "internal_cash":
      return "internal_cash";
    case "internal_autopay":
      return "internal_longterm"; // P0 CSV 叫 internal_autopay，設計文件/P1計劃叫 internal_longterm
    case "external":
      return "external";
    default:
      throw new Error(`未知 broker kind: ${v}`);
  }
}

export function mapSettlementType(v: string): SettlementType {
  switch (v) {
    case "cash":
      return "cash";
    case "autopay":
      return "autopay";
    case "salary":
      return "salary";
    case "none":
      return "none";
    default:
      throw new Error(`未知 settlement_type: ${v}`);
  }
}

export function mapBillingModel(v: string): BillingModel {
  switch (v) {
    case "per_shift":
      return "per_shift";
    case "monthly_fixed":
      return "monthly_fixed";
    case "admin_fee":
      return "admin_fee";
    case "special_income":
    case "special":
      return "special";
    default:
      throw new Error(`未知 billing_model: ${v}`);
  }
}

// 規劃 session 裁定（2026-09-11，第二輪）：
// settlement_broker_id ← shift_records.csv 嘅 settlement_unit（邊個出糧／收現金）
// operational_broker_id ← shift_records.csv 嘅 master_broker_code（總表成本桶，
//   K/W/Y/T/D/G→對應 broker；LT／空白→冇 wp5 總表覆蓋，跌返用 settlement 嗰個）
// 兩個字段都係 wp2b/shift_records.csv 嘅原生欄，對應 out/wp2b/brokers.csv 嘅
// broker_id（唔係 DB uuid，seed script 自己再用 brokerIdMap 轉一次）。
//
// 「公司兵」「LINK公司兵」「autopay_longterm」「external」唔係外判雞頭嘅
// 真名（係內部分類/業務關係描述），可以安全留喺呢度；5 個外判雞頭嘅真名
// alias（5 個外判雞頭嘅真名呢類）由 settlementUnitAliasMap()
// runtime 讀 gitignored 嘅 data/mappings-private/brokers.csv 補入嚟——
// 冇嗰個私隱檔（例如喺 CI/未授權環境）就淨係得返呢幾個非 PII key。
const SAFE_SETTLEMENT_UNIT_TO_BROKER_CSV_ID: Record<string, string> = {
  公司兵: "B06",
  LINK公司兵: "B09",
  autopay_longterm: "B07",
  external: "B10",
  // 一個承辦商發票反推嘅臨時工（SOGO CWB／Garden East，真名見 gitignored
  // 嘅 data/mappings-private/seed-overrides.json）冇對應真實 broker
  // 實體——settlement_broker_id 留 null，係已知落差，見 WP1 回報。
};

export function settlementUnitToBrokerCsvId(): Record<string, string> {
  return { ...settlementUnitAliasMap(), ...SAFE_SETTLEMENT_UNIT_TO_BROKER_CSV_ID };
}

export const MASTER_BROKER_CODE_TO_BROKER_CSV_ID: Record<string, string> = {
  K: "B01",
  W: "B02",
  Y: "B06",
  T: "B05",
  D: "B04",
  G: "B03",
};

export function mapEmploymentType(opts: { isExternal: boolean; isLongterm: boolean }): EmploymentType {
  if (opts.isExternal) return "external";
  if (opts.isLongterm) return "longterm_autopay";
  return "cash_casual";
  // 注：「散 Event」(casual_event) 喺 7 月真數據入面唔係逐人 guard 記錄
  // （HKU Y更 獨立雞頭費 94 更 5 人，老闆確認係散Event，但 P0 決定用
  // 盤級 special_items 調整表達，唔升做逐人 shift_records——見
  // mappings/billing_units.csv、P0-執行計劃.md §8 N2a）。所以呢個 CSV
  // 入面冇任何一行會行到 casual_event 分支，呢個 enum 值保留俾未來
  // UI 人手輸入用。
}
