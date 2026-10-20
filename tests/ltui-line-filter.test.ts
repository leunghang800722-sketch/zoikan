// 長工糧頁逐人結算篩選（純函數）。
import { describe, it, expect } from "vitest";
import { filterCounts, filterLines, isLeaverLine, type FilterableLine } from "@/lib/longterm-payroll/line-filter";

const L = (over: Partial<FilterableLine> & { id: string }): FilterableLine & { id: string } => ({ work_days: 20, notes_json: [], ...over });
const lines = [
  L({ id: "a" }),
  L({ id: "b", notes_json: ["★ 離職補年假：結餘 2 日"] }),
  L({ id: "c", work_days: 0 }),
  L({ id: "d", notes_json: ["⚠ 更表 SL 冇對應輸入"] }),
  L({ id: "e", work_days: 0, is_leaver: true, notes_json: [] }),
  L({ id: "f", is_leaver: false, notes_json: ["★ 離職補年假：x"] }), // DTO 有 is_leaver 就用 DTO
  L({ id: "g", al_daily_rate_basis: "avg_wage" }),
];

describe("longterm-payroll line-filter", () => {
  it("離職者：is_leaver 優先；否則 al_daily_rate_basis 或 notes 含「★ 離職補年假」", () => {
    expect(isLeaverLine(lines[1]!)).toBe(true);
    expect(isLeaverLine(lines[4]!)).toBe(true);
    expect(isLeaverLine(lines[5]!)).toBe(false);
    expect(isLeaverLine(lines[6]!)).toBe(true);
    expect(isLeaverLine(lines[0]!)).toBe(false);
  });
  it("各篩選結果同人數", () => {
    const ids = (f: "all" | "leaver" | "zero" | "warn") => filterLines(lines, f).map((x) => x.id);
    expect(ids("all")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(ids("leaver")).toEqual(["b", "e", "g"]);
    expect(ids("zero")).toEqual(["c", "e"]);
    expect(ids("warn")).toEqual(["d"]);
    expect(filterCounts(lines)).toEqual({ all: 7, leaver: 3, zero: 2, warn: 1 });
    expect(filterCounts([])).toEqual({ all: 0, leaver: 0, zero: 0, warn: 0 });
  });
});
