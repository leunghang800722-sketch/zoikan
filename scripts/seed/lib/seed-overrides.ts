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
  // 2026-07.csv 冇填 monthly_salary 嘅 longterm_autopay 安員）。權威來源
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
