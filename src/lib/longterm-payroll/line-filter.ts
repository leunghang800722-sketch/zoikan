// 長工糧頁「逐人結算」篩選（純函數，UI 用）：全部／離職者／零返工日／有警告。
// 離職者：line DTO 有 `is_leaver` 就用；冇就用 `al_daily_rate_basis` 有值，或 notes 含「★ 離職補年假」。
// 零返工日：work_days === 0。有警告：notes 含「⚠」或「警告」。
export type LineFilter = "all" | "leaver" | "zero" | "warn";

export interface FilterableLine {
  work_days: number;
  notes_json: string[];
  is_leaver?: boolean | null;
  al_daily_rate_basis?: string | null;
}

export const LEAVER_NOTE = "★ 離職補年假";

export function isLeaverLine(l: FilterableLine): boolean {
  if (typeof l.is_leaver === "boolean") return l.is_leaver;
  return !!l.al_daily_rate_basis || l.notes_json.some((n) => n.includes(LEAVER_NOTE));
}
export const isZeroDayLine = (l: FilterableLine): boolean => l.work_days === 0;
export const hasWarningLine = (l: FilterableLine): boolean => l.notes_json.some((n) => n.includes("⚠") || n.includes("警告"));

const PRED: Record<LineFilter, (l: FilterableLine) => boolean> = {
  all: () => true,
  leaver: isLeaverLine,
  zero: isZeroDayLine,
  warn: hasWarningLine,
};

export function filterLines<T extends FilterableLine>(lines: readonly T[], f: LineFilter): T[] {
  return lines.filter(PRED[f]);
}

/** 各 chip 人數。 */
export function filterCounts(lines: readonly FilterableLine[]): Record<LineFilter, number> {
  return { all: lines.length, leaver: lines.filter(isLeaverLine).length, zero: lines.filter(isZeroDayLine).length, warn: lines.filter(hasWarningLine).length };
}
