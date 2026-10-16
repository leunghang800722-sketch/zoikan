// W1：日期最終解析（純函數）。HK 時區；以訊息 ts 為今日（2026-10-16 星期五 13:00 HK）。≥20 條。
import { describe, it, expect } from "vitest";
import { resolveDates, dateInWindow, hkDateOf, addDays } from "@/lib/whatsapp/dates";

const FRI = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const DAWN_SAT = new Date("2026-10-16T18:00:00Z"); // HK 2026-10-17 02:00 星期六
const r = (raw: string | null, ts = FRI) => resolveDates({ raw }, ts);
const okDates = (raw: string, ts = FRI) => {
  const x = r(raw, ts);
  if (!x.ok) throw new Error(`expected ok for ${raw}: ${x.reason}/${x.detail}`);
  return x.dates;
};

describe("W1 dates：相對詞", () => {
  it("今日／今晚／而家／今個更 = 當日", () => {
    for (const w of ["今日", "今晚", "而家", "今個更"]) expect(okDates(w)).toEqual(["2026-10-16"]);
  });
  it("聽日／後日／大後日", () => {
    expect(okDates("聽日")).toEqual(["2026-10-17"]);
    expect(okDates("後日")).toEqual(["2026-10-18"]);
    expect(okDates("大後日")).toEqual(["2026-10-19"]);
  });
  it("琴日／尋日（過去）", () => {
    expect(okDates("琴日")).toEqual(["2026-10-15"]);
    expect(okDates("尋日")).toEqual(["2026-10-15"]);
  });
  it("月底跨月：31/10 後嘅聽日 = 1/11", () => {
    expect(okDates("聽日", new Date("2026-10-31T05:00:00Z"))).toEqual(["2026-11-01"]);
  });
  it("年底跨年：12/31 聽日 = 1/1", () => {
    expect(okDates("聽日", new Date("2026-12-31T05:00:00Z"))).toEqual(["2027-01-01"]);
  });
});

describe("W1 dates：星期", () => {
  it("星期X = 由今日起最近一個（含今日）", () => {
    expect(okDates("星期五")).toEqual(["2026-10-16"]);
    expect(okDates("星期六")).toEqual(["2026-10-17"]);
    expect(okDates("星期一")).toEqual(["2026-10-19"]);
  });
  it("下星期X = 下個（星期一起計）星期入面嘅星期X", () => {
    expect(okDates("下星期一")).toEqual(["2026-10-19"]);
    expect(okDates("下星期三")).toEqual(["2026-10-21"]);
    expect(okDates("下星期日")).toEqual(["2026-10-25"]);
    expect(okDates("下個星期五")).toEqual(["2026-10-23"]);
  });
  it("星期日喺星期六講「下星期一」= 翌日後嘅星期一", () => {
    expect(okDates("下星期一", new Date("2026-10-17T05:00:00Z"))).toEqual(["2026-10-19"]);
  });
});

describe("W1 dates：絕對日期", () => {
  it("X號：本月；已過（>2 日前）當下個月", () => {
    expect(okDates("18號")).toEqual(["2026-10-18"]);
    expect(okDates("16號")).toEqual(["2026-10-16"]);
    expect(okDates("5號")).toEqual(["2026-11-05"]);
  });
  it("X號：今日 −2 日內仍當本月（補報）", () => {
    expect(okDates("14號")).toEqual(["2026-10-14"]);
  });
  it("月初講「31 號」：上月冇 31 號 → 當本月 31 號", () => {
    expect(okDates("31號", new Date("2026-10-02T05:00:00Z"))).toEqual(["2026-10-31"]);
  });
  it("X月Y日／號", () => {
    expect(okDates("10月20號")).toEqual(["2026-10-20"]);
    expect(okDates("11月3日")).toEqual(["2026-11-03"]);
  });
  it("X/Y（HK 日/月）：20/10；17/10", () => {
    expect(okDates("20/10")).toEqual(["2026-10-20"]);
    expect(okDates("17/10")).toEqual(["2026-10-17"]);
  });
  it("X/Y 兩個解讀都合法（5/6）→ date_ambiguous 帶候選", () => {
    const x = r("5/6");
    expect(x.ok).toBe(false);
    if (!x.ok) {
      expect(x.reason).toBe("date_ambiguous");
      expect(x.candidates.length).toBe(2);
    }
  });
  it("全形數字", () => {
    expect(okDates("１８號")).toEqual(["2026-10-18"]);
  });
  it("無效日期（31/9）→ 唔解析", () => {
    const x = r("31/9");
    expect(x.ok).toBe(false);
  });
});

describe("W1 dates：相對＋絕對一致性", () => {
  it("聽日 17 號 → 一致採用", () => {
    expect(okDates("聽日17號")).toEqual(["2026-10-17"]);
  });
  it("聽日 18 號 → 唔一致 → date_inconsistent（交 Triage，帶兩個候選）", () => {
    const x = r("聽日18號");
    expect(x.ok).toBe(false);
    if (!x.ok) {
      expect(x.reason).toBe("date_inconsistent");
      expect(x.candidates).toEqual(["2026-10-17", "2026-10-18"]);
    }
  });
  it("星期六 17號 一致；星期日 17號 唔一致", () => {
    expect(okDates("星期六17號")).toEqual(["2026-10-17"]);
    expect(r("星期日17號").ok).toBe(false);
  });
  it("5/6 + 聽日（2026-10-17 唔係 5/6）→ 唔一致", () => {
    expect(r("聽日5/6").ok).toBe(false);
  });
});

describe("W1 dates：range 展開", () => {
  it("17-19 號 → 3 日", () => {
    expect(okDates("17-19號")).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
  });
  it("17至19號、17號至19號", () => {
    expect(okDates("17至19號")).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(okDates("17號至19號")).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
  });
  it("聽日至後日", () => {
    expect(okDates("聽日至後日")).toEqual(["2026-10-17", "2026-10-18"]);
  });
  it("月尾 range（29-31 號）", () => {
    expect(okDates("29-31號")).toEqual(["2026-10-29", "2026-10-30", "2026-10-31"]);
  });
  it("range 超過 14 日 → range_too_long", () => {
    const x = r("17-31號");
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.reason).toBe("range_too_long");
  });
  it("range 倒轉（19-17）→ 唔解析", () => {
    expect(r("19-17號").ok).toBe(false);
  });
});

describe("W1 dates：凌晨 00:00–05:00 跨日歧義", () => {
  it("凌晨講「今晚」→ date_ambiguous，候選＝當日、前一日", () => {
    const x = r("今晚", DAWN_SAT);
    expect(x.ok).toBe(false);
    if (!x.ok) {
      expect(x.reason).toBe("date_ambiguous");
      expect(x.detail).toBe("dawn_cross_day");
      expect(x.candidates).toEqual(["2026-10-17", "2026-10-16"]);
    }
  });
  it("凌晨講今日／而家／今個更 同樣降級", () => {
    for (const w of ["今日", "而家", "今個更"]) expect(r(w, DAWN_SAT).ok).toBe(false);
  });
  it("凌晨講「聽日」同樣降級（候選：聽日、當日）", () => {
    const x = r("聽日", DAWN_SAT);
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.candidates).toEqual(["2026-10-18", "2026-10-17"]);
  });
  it("凌晨但有絕對日期 → 照常", () => {
    expect(okDates("18號", DAWN_SAT)).toEqual(["2026-10-18"]);
    expect(okDates("聽日18號", DAWN_SAT)).toEqual(["2026-10-18"]);
  });
  it("凌晨但有星期 → 照常", () => {
    expect(okDates("星期六", DAWN_SAT)).toEqual(["2026-10-17"]);
  });
  it("凌晨講「後日」唔降級", () => {
    expect(okDates("後日", DAWN_SAT)).toEqual(["2026-10-19"]);
  });
  it("邊界：04:59 降級、05:00 唔降級", () => {
    expect(r("今日", new Date("2026-10-16T20:59:00Z")).ok).toBe(false); // HK 04:59
    expect(r("今日", new Date("2026-10-16T21:00:00Z")).ok).toBe(true); // HK 05:00
  });
  it("凌晨用 HK 日曆（UTC 仍係前一日）", () => {
    expect(hkDateOf(DAWN_SAT)).toBe("2026-10-17");
  });
});

describe("W1 dates：凌晨相對 range 降級", () => {
  it("「聽日至後日」01:00 → date_ambiguous（含聽日、當日候選）", () => {
    const x = r("聽日至後日", new Date("2026-10-16T17:00:00Z")); // HK 2026-10-17 01:00
    expect(x.ok).toBe(false);
    if (!x.ok) {
      expect(x.reason).toBe("date_ambiguous");
      expect(x.detail).toBe("dawn_cross_day");
      expect(x.candidates).toEqual(["2026-10-18", "2026-10-17"]);
    }
  });
  it("「今日至聽日」02:00 → date_ambiguous", () => {
    const x = r("今日至聽日", DAWN_SAT);
    expect(x.ok).toBe(false);
    if (!x.ok) expect([...x.candidates].sort()).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
  });
  it("「後日至大後日」凌晨唔降級；數字 range 凌晨不變；日間「聽日至後日」不變", () => {
    expect(okDates("後日至大後日", DAWN_SAT)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(okDates("17-19號", DAWN_SAT)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(okDates("聽日至後日")).toEqual(["2026-10-17", "2026-10-18"]);
  });
});

describe("W1 dates：缺失／亂碼", () => {
  it("冇日期文字 → date_missing", () => {
    const x = r(null);
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.reason).toBe("date_missing");
  });
  it("睇唔明嘅字 → date_unparseable", () => {
    const x = r("遲啲");
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.reason).toBe("date_unparseable");
  });
});

describe("W1 dates：窗口 −2～+45", () => {
  it("邊界", () => {
    expect(dateInWindow(addDays("2026-10-16", -2), FRI)).toBe(true);
    expect(dateInWindow(addDays("2026-10-16", -3), FRI)).toBe(false);
    expect(dateInWindow(addDays("2026-10-16", 45), FRI)).toBe(true);
    expect(dateInWindow(addDays("2026-10-16", 46), FRI)).toBe(false);
  });
});
