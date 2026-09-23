// WP-ROSTER-UPLOAD Phase A（§15.3）：格仔代號 → 種類對照表。由
// `tools/importer/mappings/cell_codes.csv`（只讀，唔改）搬過嚟——**淨係
// 搬代號同種類**，唔搬任何個人資料。加埋 8 月試算 `data/2026-09/
// aug-payroll-trial/scripts/s02_extract.py` patch 3 嘅 `M`（中更）／
// `OT<任意數字>`（例：OT3.5）呢兩條規則，做成呢個解析器嘅**核心行為**
// （唔係 monkeypatch）。
//
// `pointer`（python 版用字）呢度改叫 `marker`（同 prisma schema
// `RosterUploadCodeKind` 一致，見 P2-版面重設計計劃.md §15.3 用字）。
export type CodeKind = "shift" | "leave" | "ot" | "marker" | "unknown";

// 對應 tools/importer/mappings/cell_codes.csv 逐行（code,kind,description）。
const BASE_CODE_KIND: Readonly<Record<string, CodeKind>> = {
  N: "shift", // 夜更保安員 一般代號
  D: "shift", // 日更/早更保安員 一般代號
  C: "shift", // HKU座頭 C更（8.25小時）
  C1: "shift", // HKU座頭 C1更
  IC: "shift", // Zone IC / 早更IC 一般代號
  SIC: "shift", // 高級IC（Senior IC）
  Y: "shift", // HKU Y更成盤用嘅上班代號（格仔代號，同 A 欄雞頭代號 Y=公司兵唔同意思）
  OT1: "ot", // HKU座頭獨立一行 0615-0715 OT
  RD: "leave", // 例假 Rest Day
  SH: "leave", // 輪班津貼/短假
  AL: "leave", // 年假 Annual Leave
  SL: "leave", // 病假 Sick Leave
  NPL: "leave", // 無薪假（NPL=NL，同一類）
  NL: "leave", // 無薪假 No Pay Leave
  OFF: "leave", // 假期（OFF=RD，同一類，保留原代號方便追溯）
  數據中心: "marker", // 數碼港 CP5 檔內指向數據中心盤嘅指針格
  // 8 月試算 patch 3：中更保安員（免稅店 1500-2330、東濤苑 1500-2300）。
  M: "shift",
};

// 8 月試算 patch 3：任何 `OT<數字>`（可帶小數，例如 OT3.5）都當 ot——
// 唔淨係列死嘅 OT1。
const OT_PATTERN_RE = /^OT(\d+(?:\.\d+)?)$/i;

export function classifyCode(rawCode: string): CodeKind {
  const trimmed = rawCode.trim();
  if (trimmed in BASE_CODE_KIND) return BASE_CODE_KIND[trimmed]!;
  if (OT_PATTERN_RE.test(trimmed)) return "ot";
  return "unknown";
}

/** OT<n> 代號嘅 n（小時數）；淨係 code_kind=ot 而且真係 `OT<數字>` 形狀先
 * 有值（`OT1` 呢類固定代號都啱好符合形狀，返 1）。其他 ot 代號（理論上
 * 而家冇）返 null。 */
export function otHoursFromCode(rawCode: string): number | null {
  const m = OT_PATTERN_RE.exec(rawCode.trim());
  return m ? Number(m[1]) : null;
}

// 統計行標籤（tools/importer/mappings/stat_row_labels.csv）——Phase A
// 唔重推 WP1 嘅逐日對數邏輯，淨係要識別呢啲行**唔係**安員行，解析嗰陣
// 整行跳過（唔生成 roster_upload_rows）。
export const STAT_ROW_LABELS: ReadonlySet<string> = new Set(["Total", "所需人手", "尚欠", "早加夜"]);
