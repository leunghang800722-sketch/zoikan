// 長工糧頁「逐人結算」篩選（純函數，UI 用）：全部／離職者／零返工日／有警告。
// 離職者：line DTO 有 `is_leaver` 就用；冇就用 `al_daily_rate_basis` 有值，或 notes 含「★ 離職補年假」。
// 零返工日：work_days === 0。有警告：notes 含「⚠」或「警告」。
export type LineFilter = "all" | "leaver" | "zero" | "warn";

export interface FilterableLine {
  guard_id?: string;
  work_days: number;
  notes_json: string[];
  is_leaver?: boolean | null;
  al_daily_rate_basis?: string | null;
}

const LEAVER_NOTE = "★ 離職補年假";

export function isLeaverLine(l: FilterableLine): boolean {
  if (typeof l.is_leaver === "boolean") return l.is_leaver;
  return !!l.al_daily_rate_basis || l.notes_json.some((n) => n.includes(LEAVER_NOTE));
}
export const isZeroDayLine = (l: FilterableLine): boolean => l.work_days === 0;
/** 有警告：行 notes 含「⚠」／「警告」，或者 run 層警告（`warnings_by_guard`：rehire_detected／card_guard_date_mismatch／two_segments_in_month／segment_starts_after_month／rehire_suspected…）按 guard_id 命中。 */
function hasWarningLine(l: FilterableLine, runWarnGuardIds?: ReadonlySet<string>): boolean {
  return l.notes_json.some((n) => n.includes("⚠") || n.includes("警告")) || (!!l.guard_id && !!runWarnGuardIds?.has(l.guard_id));
}

/** `warnings_by_guard`（只 code）→ 有警告嘅 guard_id 集合。 */
export function runWarnGuardSet(w: ReadonlyArray<{ guard_id: string; codes: readonly string[] }> | null | undefined): Set<string> {
  return new Set((w ?? []).filter((x) => x.codes.length > 0).map((x) => x.guard_id));
}

function pred(f: LineFilter, runWarn?: ReadonlySet<string>): (l: FilterableLine) => boolean {
  switch (f) {
    case "leaver":
      return isLeaverLine;
    case "zero":
      return isZeroDayLine;
    case "warn":
      return (l) => hasWarningLine(l, runWarn);
    default:
      return () => true;
  }
}

export function filterLines<T extends FilterableLine>(lines: readonly T[], f: LineFilter, runWarn?: ReadonlySet<string>): T[] {
  return lines.filter(pred(f, runWarn));
}

/** 各 chip 人數。 */
export function filterCounts(lines: readonly FilterableLine[], runWarn?: ReadonlySet<string>): Record<LineFilter, number> {
  return { all: lines.length, leaver: lines.filter(isLeaverLine).length, zero: lines.filter(isZeroDayLine).length, warn: lines.filter((l) => hasWarningLine(l, runWarn)).length };
}
