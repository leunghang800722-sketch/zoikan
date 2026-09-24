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
    { id: "ic-am", siteId: "S", code: "IC", timeSlot: "0700-1500", billingGroup: "per_shift" as const },
    { id: "ic-pm", siteId: "S", code: "IC", timeSlot: "1430-2230", billingGroup: "per_shift" as const },
    { id: "ic-nt", siteId: "S", code: "ic", timeSlot: "2230-0730", billingGroup: "per_shift" as const },
    { id: "x1", siteId: "S", code: "X", timeSlot: "0700-1900", billingGroup: "per_shift" as const },
    { id: "x2", siteId: "S", code: "X", timeSlot: "0700-1900", billingGroup: "per_shift" as const },
    { id: "d", siteId: "S", code: "D", timeSlot: "0730-1930", billingGroup: "per_shift" as const },
    { id: "other", siteId: "T", code: "D", timeSlot: "0700-1900", billingGroup: "per_shift" as const },
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

// 補丁（§17.7 未修第一項）：數碼港 CP5 dev DB 有兩個 0750-1950 更種——
// `D`（billing_group=monthly_ic，IC 月費崗）同 `D-2`（per_shift，普通
// 兵，DB unique 淨係睇 code+start_time，跟「-N 後綴分開」慣例起嘅）。
// 更表格仔嘅 rawCode 淨係寫「D」——`codeFamily()` 要湊齊 D／D-2 兩個候
// 選（唔係逐字相等），time_raw 收窄唔到（兩個候選時段字面完全一樣），
// 要用 rank_raw 第三層收窄。純函數測試，零 DB 依賴。
describe("matchShiftType：rank_raw 第三層收窄（時段收窄唔到、候選時段完全一樣）", () => {
  const cp5 = [
    { id: "d-ic", siteId: "CP5", code: "D", timeSlot: "0750-1950", billingGroup: "monthly_ic" as const },
    { id: "d-guard", siteId: "CP5", code: "D-2", timeSlot: "0750-1950", billingGroup: "per_shift" as const },
  ];

  it("rawCode「D」用 codeFamily() 湊埋「D-2」做候選（唔係逐字相等）", () => {
    // 直接驗證：rank 冇資訊嗰陣都仲係見到兩個候選（ambiguous），證明
    // matches 入面已經有齊 D／D-2，唔係淨係得逐字相等嘅「D」一個。
    const r = matchShiftType("D", "shift", "CP5", null, cp5, null);
    expect(r.ambiguous).toBe(true);
    expect(r.candidateTimeSlots).toEqual(["0750-1950", "0750-1950"]);
  });

  it("rank 含「IC」（例：早更IC）→ 收窄去 billing_group=monthly_ic 嗰個", () => {
    expect(matchShiftType("D", "shift", "CP5", "0750-1950", cp5, "早更IC")).toEqual({ id: "d-ic", ambiguous: false, matchedViaRank: true });
  });

  it("rank 含「SIC」→ 一樣當 IC 類收窄", () => {
    expect(matchShiftType("D", "shift", "CP5", "0750-1950", cp5, "夜更SIC")).toEqual({ id: "d-ic", ambiguous: false, matchedViaRank: true });
  });

  it("rank 係「保安員」類（例：早更保安員）→ 收窄去 per_shift 嗰個", () => {
    expect(matchShiftType("D", "shift", "CP5", "0750-1950", cp5, "早更保安員")).toEqual({ id: "d-guard", ambiguous: false, matchedViaRank: true });
  });

  it("rank 寫「Guard」（英文、唔含 IC）→ 一樣當保安員類收窄", () => {
    expect(matchShiftType("D", "shift", "CP5", "0750-1950", cp5, "Guard")).toEqual({ id: "d-guard", ambiguous: false, matchedViaRank: true });
  });

  it("空 rank（null／得返空白）→ 冇資訊可以收窄，照舊 ambiguous，rankAttempted=false", () => {
    const r1 = matchShiftType("D", "shift", "CP5", "0750-1950", cp5, null);
    expect(r1).toEqual({ id: null, ambiguous: true, candidateTimeSlots: ["0750-1950", "0750-1950"], rankAttempted: false });
    const r2 = matchShiftType("D", "shift", "CP5", "0750-1950", cp5, "   ");
    expect(r2.ambiguous).toBe(true);
    expect(r2.rankAttempted).toBe(false);
  });

  it("rank 同候選夾唔到（呢個盤根本冇 monthly_ic 候選，rank 話係 IC）→ 照舊 ambiguous，但 rankAttempted=true 講明試過", () => {
    const allGuard = [
      { id: "g1", siteId: "T2", code: "D", timeSlot: "0700-1900", billingGroup: "per_shift" as const },
      { id: "g2", siteId: "T2", code: "D", timeSlot: "0700-1900", billingGroup: "per_shift" as const },
    ];
    const r = matchShiftType("D", "shift", "T2", "0700-1900", allGuard, "早更IC");
    expect(r.id).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.rankAttempted).toBe(true);
  });
});
