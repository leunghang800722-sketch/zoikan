// P1-WP4（規劃裁定）：長工月薪缺數要用 BOCHK 權威值。呢部機而家已知有
// `tools/importer/venv/`（裝咗 msoffcrypto/xlrd/openpyxl，唔使裝任何
// 嘢）——用嗰個 venv 嘅 python 叫 `scripts/seed/lib/py/
// extract_bochk_payroll.py`（新寫嘅 wrapper，唔改 P0 code）行
// `tools/importer/importer/wp4_bochk.py` 原封不動嘅解密/讀取邏輯，
// dump 一份 gitignored JSON（`out/bochk-payroll.json`），呢度讀返嚟做
// {english_name(正規化): amount} 嘅 Map。
//
// PDPO：呢個檔案（git-tracked，scripts/）淨係得邏輯，冇任何真名/工號
// 字面；實際英文名只會出現喺 runtime 產生嘅 out/ JSON（gitignored）度。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VENV_PYTHON = path.resolve(process.cwd(), "tools/importer/venv/bin/python");
const WRAPPER_SCRIPT = path.resolve(process.cwd(), "scripts/seed/lib/py/extract_bochk_payroll.py");
const OUT_JSON = path.resolve(process.cwd(), "out/bochk-payroll.json");

interface BochkRow {
  english_name: string;
  amount: string;
}
interface BochkPayload {
  ok: boolean;
  error?: string;
  rows?: BochkRow[];
}

function normalizeName(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

let cached: Map<string, number> | null | undefined;

/** 讀 BOCHK 長工 autopay 發薪表，回傳 {正規化英文名 -> 呢個月金額}
 * 嘅 Map。冇 venv／解密失敗／檔案唔存在就回傳 null（唔 throw——冇呢個
 * 私隱檔嘅環境要照樣 seed 得到，跌返用 seed-overrides.json 嘅靜態值）。 */
export function loadBochkPayrollByName(): Map<string, number> | null {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(VENV_PYTHON)) {
    cached = null;
    return cached;
  }
  try {
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    execFileSync(VENV_PYTHON, [WRAPPER_SCRIPT, OUT_JSON], { stdio: "pipe" });
    const payload = JSON.parse(fs.readFileSync(OUT_JSON, "utf-8")) as BochkPayload;
    if (!payload.ok || !payload.rows) {
      cached = null;
      return cached;
    }
    const map = new Map<string, number>();
    for (const r of payload.rows) {
      map.set(normalizeName(r.english_name), Number(r.amount));
    }
    cached = map;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

export function bochkAmountForName(nameEn: string | null | undefined): number | null {
  if (!nameEn) return null;
  const map = loadBochkPayrollByName();
  if (!map) return null;
  return map.get(normalizeName(nameEn)) ?? null;
}
