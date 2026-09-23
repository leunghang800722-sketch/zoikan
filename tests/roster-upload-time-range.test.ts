// WP-ROSTER-UPLOAD Phase B-0（§15.3 第 2 項）：`normalizeTimeRange()`／
// `shiftTypeTimeSlot()` 獨立單元測試——零 DB 依賴，8 種常見更表 Time 欄
// 寫法都要正規化做同一個 "HHMM-HHMM"。
import { describe, it, expect } from "vitest";
import { normalizeTimeRange, shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";
import { matchShiftType } from "@/lib/roster-upload/match";

describe("normalizeTimeRange：8 種寫法", () => {
  it("1. 0700-1900（冇冒號、冇空白）", () => {
    expect(normalizeTimeRange("0700-1900")).toBe("0700-1900");
  });
  it("2. 07:00-19:00（有冒號）", () => {
    expect(normalizeTimeRange("07:00-19:00")).toBe("0700-1900");
  });
  it("3. 0700 - 1900（連字符前後有空白）", () => {
    expect(normalizeTimeRange("0700 - 1900")).toBe("0700-1900");
  });
  it("4. 07:00 - 19:00（有冒號又有空白）", () => {
    expect(normalizeTimeRange("07:00 - 19:00")).toBe("0700-1900");
  });
  it("5. 1930-0730（跨午夜，純字面比對唔計時長）", () => {
    expect(normalizeTimeRange("1930-0730")).toBe("1930-0730");
  });
  it("6. 7:00-19:00（單位數鐘頭冇補零）", () => {
    expect(normalizeTimeRange("7:00-19:00")).toBe("0700-1900");
  });
  it("7. 0700~1900（波浪號）", () => {
    expect(normalizeTimeRange("0700~1900")).toBe("0700-1900");
  });
  it("8. 0700 to 1900（英文 to）", () => {
    expect(normalizeTimeRange("0700 to 1900")).toBe("0700-1900");
  });

  it("解唔到嘅格式／唔存在嘅鐘數 → null（唔准估）", () => {
    expect(normalizeTimeRange("成日")).toBeNull();
    expect(normalizeTimeRange("2500-1900")).toBeNull();
    expect(normalizeTimeRange("0700-1961")).toBeNull();
    expect(normalizeTimeRange(null)).toBeNull();
    expect(normalizeTimeRange("")).toBeNull();
  });

  // 驗收 2026-09-23 補測：全形數字／全形冒號（NFKC 正規化）。
  it("全形數字／全形冒號 → 一樣正規化", () => {
    expect(normalizeTimeRange("０７００-１９００")).toBe("0700-1900");
    expect(normalizeTimeRange("07：00-19：00")).toBe("0700-1900");
  });
});

describe("shiftTypeTimeSlot：DB Time 欄 → HHMM-HHMM", () => {
  it("正常一對 start/end", () => {
    const start = new Date(Date.UTC(1970, 0, 1, 7, 0, 0));
    const end = new Date(Date.UTC(1970, 0, 1, 19, 0, 0));
    expect(shiftTypeTimeSlot(start, end)).toBe("0700-1900");
  });
  it("任何一邊冇值 → null", () => {
    expect(shiftTypeTimeSlot(null, new Date())).toBeNull();
    expect(shiftTypeTimeSlot(new Date(), null)).toBeNull();
  });
  it("同 normalizeTimeRange() 輸出一致，可以逐字比對", () => {
    const start = new Date(Date.UTC(1970, 0, 1, 19, 30, 0));
    const end = new Date(Date.UTC(1970, 0, 1, 7, 30, 0));
    expect(shiftTypeTimeSlot(start, end)).toBe(normalizeTimeRange("1930-0730"));
  });
});

// 驗收 2026-09-23 補測：`matchShiftType()` 收窄三條路之前冇純函數測試。
describe("matchShiftType：time_raw 收窄", () => {
  const cands = [
    { id: "ic-am", siteId: "S", code: "IC", timeSlot: "0700-1500" },
    { id: "ic-pm", siteId: "S", code: "IC", timeSlot: "1430-2230" },
    { id: "ic-nt", siteId: "S", code: "ic", timeSlot: "2230-0730" },
    { id: "x1", siteId: "S", code: "X", timeSlot: "0700-1900" },
    { id: "x2", siteId: "S", code: "X", timeSlot: "0700-1900" },
    { id: "d", siteId: "S", code: "D", timeSlot: "0730-1930" },
    { id: "other", siteId: "T", code: "D", timeSlot: "0700-1900" },
  ];
  it("同代號多個候選，時段一個命中 → 配（代號大小寫、時段寫法唔影響）", () => {
    expect(matchShiftType("IC", "shift", "S", "14:30 - 22:30", cands)).toEqual({ id: "ic-pm", ambiguous: false });
    expect(matchShiftType("ic", "shift", "S", "2230～0730", cands)).toEqual({ id: "ic-nt", ambiguous: false });
  });
  it("時段零個命中 → null＋列晒候選時段", () => {
    const r = matchShiftType("IC", "shift", "S", "0900-1700", cands);
    expect(r.id).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidateTimeSlots).toEqual(["0700-1500", "1430-2230", "2230-0730"]);
  });
  it("時段仍然多過一個命中 → null＋列候選（唔准估）", () => {
    const r = matchShiftType("X", "shift", "S", "0700-1900", cands);
    expect(r.id).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidateTimeSlots).toEqual(["0700-1900", "0700-1900"]);
  });
  it("冇 time_raw／解唔到 → 多候選照舊 ambiguous", () => {
    expect(matchShiftType("IC", "shift", "S", null, cands).ambiguous).toBe(true);
    expect(matchShiftType("IC", "shift", "S", "成日", cands).ambiguous).toBe(true);
  });
  it("淨係一個候選 → 直接配（唔理 time_raw）；零個 → null 唔係 ambiguous；其他盤唔會撈埋", () => {
    expect(matchShiftType("D", "shift", "S", "垃圾", cands)).toEqual({ id: "d", ambiguous: false });
    expect(matchShiftType("Z", "shift", "S", "0700-1900", cands)).toEqual({ id: null, ambiguous: false });
    expect(matchShiftType("D", "shift", null, "0700-1900", cands)).toEqual({ id: null, ambiguous: false });
    expect(matchShiftType("AL", "leave", "S", null, cands)).toEqual({ id: null, ambiguous: false });
  });
});
