// PDPO 裁定（Opus 對抗式驗收）：雞頭真名唔入 git——外判雞頭嘅真實稱呼
// 一律搬去 `data/mappings-private/brokers.csv`（gitignored，data/ 成個
// 資料夾都 gitignored），冇呢個檔案就淨係用代號（K/W/G/D/T）做名。
//
// 「公司兵」／「LINK公司兵」／「autopay_longterm」／「external」呢啲唔係
// 個人/業務伙伴真名（係內部分類/業務關係描述），照舊留喺 mapping.ts。
import fs from "node:fs";
import { readCsv } from "./csv";
import { DATA } from "./paths";

export interface BrokerNameRow {
  broker_csv_id: string;
  code: string;
  canonical_name: string;
  /** P0 private 檔欄名係 `aliases`（糧明細頁寫法）；舊欄名 `settlement_unit_aliases` 保留相容 */
  aliases?: string;
  settlement_unit_aliases?: string;
  master_roster_aliases?: string;
}

const PRIVATE_BROKERS_CSV = DATA("mappings-private/brokers.csv");

let cached: BrokerNameRow[] | null = null;
function loadPrivateBrokerNames(): BrokerNameRow[] {
  if (cached) return cached;
  if (!fs.existsSync(PRIVATE_BROKERS_CSV)) {
    cached = [];
    return cached;
  }
  cached = readCsv<BrokerNameRow>(PRIVATE_BROKERS_CSV);
  return cached;
}

/** canonical_name（真名）——搵唔到私隱檔／呢個 broker_id 就跌返用代號。 */
export function canonicalNameFor(brokerCsvId: string, code: string | null | undefined): string {
  const row = loadPrivateBrokerNames().find((r) => r.broker_csv_id === brokerCsvId);
  return row?.canonical_name || code || brokerCsvId;
}

/** settlement_unit（真名）→ broker_csv_id 嘅對照——冇私隱檔就得返空
 * object（seed 嗰陣 settlement_unit 係呢類真名嘅記錄會跌返冇 broker
 * 對應，屬已知限制，唔係 bug——冇私隱檔本身就代表冇授權用真名做對照）。 */
export function settlementUnitAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of loadPrivateBrokerNames()) {
    // P0 結算單位名 = canonical_name（例如 P0 shift_records.settlement_unit）；糧明細頁名 = aliases；總表稱呼 = master_roster_aliases
    const all = [row.canonical_name || "", row.aliases || row.settlement_unit_aliases || "", row.master_roster_aliases || ""].join(";");
    for (const alias of all.split(";").map((s) => s.trim()).filter(Boolean)) {
      map[alias] = row.broker_csv_id;
    }
  }
  return map;
}
