// WP-R1：更別代號配色——README 淨係定咗 D／N／SH／RD／AL（請假）幾個
// 具體代號；其餘更別（IC／SIC／D-2／Y…）用中性色 chip（Fable 規劃判斷，
// 見 P2-版面重設計計劃.md §2）。請假一律用 AL 嗰款虛線樣式（唔理實際
// leave_code 係邊個）；draft（待審批）一律透明底虛線藍框，蓋過其他規則。
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
  if (opts.isLeave) return LEAVE;
  if (!code) return { bg: "transparent", fg: "transparent" };
  const fixed = FIXED[code.toUpperCase()];
  if (fixed) return fixed;
  return NEUTRAL;
}
