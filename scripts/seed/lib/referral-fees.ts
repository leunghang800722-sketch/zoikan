// P1-WP4（規劃裁定）：長工雞頭費——攞 P0 已經驗證過（老闆核實表分毫不
// 差）嘅費用行金額。原理見 scripts/seed/lib/py/extract_referral_fees.py
// 頂註解：呢個金額本身係老闆手打喺「在勤總表」嘅費用行，唔係一條可以
// 由 shift_records 逐更計返嚟嘅公式——所以呢度直接攞 P0 已驗證嘅金額
// seed 做 special_items（kind=referral_fee），唔喺 DB 側重新發明公式。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VENV_PYTHON = path.resolve(process.cwd(), "tools/importer/venv/bin/python");
const WRAPPER_SCRIPT = path.resolve(process.cwd(), "scripts/seed/lib/py/extract_referral_fees.py");
const OUT_JSON = path.resolve(process.cwd(), "out/referral-fees.json");

export interface ReferralFeeBlockRow {
  broker_id: string; // B01/B02/B03/B05…（P0 mappings/brokers.csv 嘅 broker_csv_id）
  block: string;
  amount: string;
}
interface ReferralFeePayload {
  ok: boolean;
  error?: string;
  by_broker_total?: Record<string, string>;
  by_broker_block?: ReferralFeeBlockRow[];
}

let cached: ReferralFeePayload | null | undefined;

export function loadReferralFees(): ReferralFeePayload | null {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(VENV_PYTHON)) {
    cached = null;
    return cached;
  }
  try {
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    execFileSync(VENV_PYTHON, [WRAPPER_SCRIPT, OUT_JSON], { stdio: "pipe" });
    const payload = JSON.parse(fs.readFileSync(OUT_JSON, "utf-8")) as ReferralFeePayload;
    cached = payload.ok ? payload : null;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

// block 文字 → P0 site_id（tools/importer/mappings/sites.csv）——淨係
// 有把握、唔含糊嘅先填（啟航1331／CP5／IFC／九龍企業大廈／卓弘）；
// 「城巴車廠」跨 8 個 site（S018-S025）、「Weave」跨 3 個 site（S004/
// S014/S015）、「港大職員宿舍」喺 sites.csv 搵唔到精確對應——呢啲留
// unattributed（siteId=null），唔靠估。
const BLOCK_TO_SITE_CSV_ID: Record<string, string> = {
  啟航1331: "S017",
  CP5: "S011",
  "IFC 12hrs (N/S)": "S002",
  IFC: "S002",
  九龍企業大廈: "S016",
  卓弘物業服務有限公司: "S039",
};

export function siteCsvIdForBlock(block: string): string | null {
  if (BLOCK_TO_SITE_CSV_ID[block]) return BLOCK_TO_SITE_CSV_ID[block];
  for (const [key, siteCsvId] of Object.entries(BLOCK_TO_SITE_CSV_ID)) {
    if (block.includes(key)) return siteCsvId;
  }
  return null;
}
