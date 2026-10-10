// B2（Opus 對抗式驗收第四輪）：某幾個 settlement_unit 真名（例如
// SOGO CWB／Garden East 發票反推嘅臨時工，佢哋嘅 settlement_unit 值
// 本身就係一間真實承辦商公司名）本身已知冇對應嘅 broker 實體——呢個
// KNOWN_UNMAPPED 例外名單唔可以直接寫呢個公司名喺 git-tracked 檔。
// 由 gitignored 嘅 data/mappings-private/seed-overrides.json 讀入；冇
// 私隱檔就跌返空 array，seed 嗰陣呢個值會變成「未登記」而 throw（見
// scripts/seed/index.ts）——呢個係刻意行為，唔係 bug：冇私隱檔嘅環境
// （例如 CI／未授權機器）冇辦法自己判斷邊個 settlement_unit 屬於呢類
// 已知例外，寧願安全地 throw 逼人手覆核，都唔靜默假設。
import fs from "node:fs";
import { DATA } from "./paths";

const SEED_OVERRIDES_JSON = DATA("mappings-private/seed-overrides.json");

interface SeedOverrides {
  knownUnmappedSettlementUnits?: string[];
  // P1-WP4 WP1 遺留 item 5：長工月薪缺數（guards.csv/longterm_staff_
  // 2026-07.csv 冇填 monthly_salary 嘅 longterm_autopay 保安員）。權威來源
  // 本應係 data/2026-07/reference/ 嗰份 BOCHK autopay 發薪檔（Excel
  // VelvetSweatshop 加密，P0 tools 用 msoffcrypto+xlrd 解），但呢部開發
  // 機冇裝任何 python 套件（連 requirements.txt 列嘅 openpyxl 都冇裝到，
  // 唔准裝系統/套件軟件）——呢個檔案解唔到。改用 data/2026-07/reference/
  // 嗰份 Maxwell 長工月薪表（純 xlsx，用現有 exceljs 直接讀）嘅上一個月
  // sheet（呢幾個人 7 月份 sheet 完全冇出現——可能已經喺 7 月中途調離
  // 前線薪酬表，但 7 月仍然有出更記錄——用返上月最後已知月薪值，並喺
  // P1-執行計劃.md 回報標明呢個係取捨，唔係 P0 已核實嘅權威值）。Key
  // 用 guards.staff_no（PDPO：實際工號值只喺呢個 gitignored data/ 檔
  // 入面，唔入 git-tracked 嘅 scripts/——呢個型別定義淨係話「key 係
  // staff_no」，冇任何實際工號字面）。
  monthlySalaryOverrides?: Record<string, number>;
  // P1-WP4：雞頭每更雞頭費率（老闆 2026-09-13 提供；P0 源頭嘅糧明細／
  // 總表只有出街價合計，冇拆開保安員工資／雞頭費——正式庫已經用一次性
  // 腳本拆咗，seed 要做返同一件事先至唔會令本機重 seed 退返舊嘅合計卡／
  // 合計 snapshot，見 scripts/seed/lib/broker-fee-split.ts）。Key 用
  // broker_csv_id（例如 K 嘅代號）；bySite 嘅 key 用盤嘅 canonical_name
  // （盤名唔算 PDPO 定義嘅真名，可以留喺呢個檔案）。
  brokerFeeRules?: Record<string, { default: number; bySite?: Record<string, number> }>;
  // P1-WP4：一次性補漏卡（2026-09-13 老闆質詢後跟進）——P0 源頭有幾個
  // site×broker 組合完全冇任何 rate_cards 卡（唔係「有卡但價錯」，係
  // 「連卡都冇」），令 shift_records 快照 guard_wage_snapshot 一直留空、
  // 個更次靜靜哋變咗 $0 成本。P0 總表（tools/importer/out/wp5/
  // master_posts.csv）其實有嗰個崗位嘅外判價，只係冇轉做 rate_cards 卡
  // ——見 scripts/seed/lib/extra-rate-cards.ts。呢個 array 逐項係一張
  // 要補嘅卡；`site` 用盤嘅 canonical_name（盤名唔算真名，可以留喺呢個
  // 檔案），實際套用嘅 shift_type_id 由 extra-rate-cards.ts 喺 runtime
  // 反推（搵返呢個 site+broker 組合入面邊啲更次冇 guard_wage_snapshot），
  // 唔喺呢度手動指定，避免人手估錯漏咗某個更型。
  extraRateCards?: Array<{
    broker_csv_id: string;
    site: string;
    payout_rate: number;
    client_rate?: number | null;
    effective_from: string;
    effective_to?: string | null;
    source?: string;
    note?: string;
  }>;
}

let cached: SeedOverrides | null = null;
function load(): SeedOverrides {
  if (cached) return cached;
  if (!fs.existsSync(SEED_OVERRIDES_JSON)) {
    cached = {};
    return cached;
  }
  cached = JSON.parse(fs.readFileSync(SEED_OVERRIDES_JSON, "utf-8")) as SeedOverrides;
  return cached;
}

export function knownUnmappedSettlementUnits(): string[] {
  return load().knownUnmappedSettlementUnits ?? [];
}

export function monthlySalaryOverrides(): Record<string, number> {
  return load().monthlySalaryOverrides ?? {};
}

export function brokerFeeRules(): Record<string, { default: number; bySite?: Record<string, number> }> {
  return load().brokerFeeRules ?? {};
}

export interface ExtraRateCardOverride {
  broker_csv_id: string;
  site: string;
  payout_rate: number;
  client_rate?: number | null;
  effective_from: string;
  effective_to?: string | null;
  source?: string;
  note?: string;
}

export function extraRateCardOverrides(): ExtraRateCardOverride[] {
  return load().extraRateCards ?? [];
}
