// WP-R1：更別代號配色——README 淨係定咗 D／N／SH／RD／AL（請假）幾個
// 具體代號；其餘更別（IC／SIC／D-2／Y…）用中性色 chip（Fable 規劃判斷，
// 見 P2-版面重設計計劃.md §2）。請假一律用 AL 嗰款虛線樣式（唔理實際
// leave_code 係邊個）；draft（待審批）一律透明底虛線藍框，蓋過其他規則。
//
// WP-R2 Opus 驗收 fix（第 1 項）：RD／SH 本身都喺 `LEAVE_CODES`
// （RosterEditor.tsx）入面（RD＝休息日、SH 用嚟標記另一種更別但都可以
// 用嚟請假），所以呼叫方會傳 `isLeave: true`。但 README §04 對 RD／SH
// 定咗自己專屬嘅配色（RD 中性灰、SH 青色），唔可以畀 isLeave 蓋過變成
// 橙色虛線——所以優先順序要係：isDraft ＞ FIXED（代號本身有固定配色
// 就用返，唔理 isLeave）＞ isLeave（其餘請假代號 AL/SL/NL/OFF/NPL）＞
// NEUTRAL。
export interface ShiftCellStyle {
  bg: string;
  fg: string;
  /** CSS border 簡寫；`undefined` 表示冇邊（實色 chip）。 */
  border?: string;
}

const FIXED: Record<string, ShiftCellStyle> = {
  D: { bg: "#dbeafe", fg: "#1e40af" },
  N: { bg: "#e0e7ff", fg: "#3730a3" },
  SH: { bg: "#ccfbf1", fg: "#0f766e" },
  RD: { bg: "#f1f5f9", fg: "#64748b" },
};

const LEAVE: ShiftCellStyle = { bg: "#fff", fg: "#b45309", border: "1px dashed #f59e0b" };
const DRAFT: ShiftCellStyle = { bg: "transparent", fg: "#1e40af", border: "1px dashed #2563eb" };
const NEUTRAL: ShiftCellStyle = { bg: "#f1f5f9", fg: "#475569" };

export function shiftCodeStyle(code: string | null | undefined, opts: { isLeave?: boolean; isDraft?: boolean } = {}): ShiftCellStyle {
  // draft 狀態蓋過晒代號本身嘅底色（待審批入面 D／N／SH 都係同一個虛線樣）。
  if (opts.isDraft) return DRAFT;
  if (!code) return { bg: "transparent", fg: "transparent" };
  // FIXED 查表（D/N/SH/RD）優先於 isLeave——RD／SH 就算喺 LEAVE_CODES
  // 入面都要用返自己嗰款固定配色，唔畀「請假」橙虛線蓋過。
  const fixed = FIXED[code.toUpperCase()];
  if (fixed) return fixed;
  if (opts.isLeave) return LEAVE;
  return NEUTRAL;
}
