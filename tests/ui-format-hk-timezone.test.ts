// R3 驗收 A1：`todayLocalStr()`／`greetingWord()`／`currentMonthStr()`
// 原本用「跑呢段 code 嗰部機」嘅本地時區（`Date.getTimezoneOffset()`／
// `Date.getHours()`／`Date.getFullYear()`）——SSR 喺正式站容器係 UTC，
// 瀏覽器係用戶本地時區，兩邊唔一致就 hydration mismatch，亦令 HK
// 00:00–08:00「今日」計錯一日、18:00 後問候語計錯。修法：全部固定用
// `Asia/Hong_Kong`（`Intl.DateTimeFormat`），唔理跑喺邊個時區嘅機。
//
// 呢度純函數 unit test（唔使起 DB），用固定 `now` 注入覆蓋 UTC 邊界：
// UTC 16:30 ＝ 香港時間（UTC+8，冇 DST）翌日 00:30。
import { describe, expect, it } from "vitest";
import { todayLocalStr, greetingWord, currentMonthStr, addMonthsStr } from "@/lib/ui/format";

describe("R3 驗收 A1：format.ts 香港時區 helper", () => {
  describe("todayLocalStr()——UTC 16:00 跨日邊界（HK=UTC+8，冇 DST：UTC 16:00 就係香港翌日 00:00；UTC 16:30＝HK 翌日 00:30）", () => {
    it("UTC 2026-07-15T15:59:59（＝香港時間 2026-07-15T23:59:59，仲未跨日）→ 香港日期仍然係 2026-07-15", () => {
      const now = new Date("2026-07-15T15:59:59.000Z");
      expect(todayLocalStr(now)).toBe("2026-07-15");
    });

    it("UTC 2026-07-15T16:00:00（＝香港時間 2026-07-16T00:00:00，啱啱跨日）→ 香港日期已經跳咗做 2026-07-16", () => {
      const now = new Date("2026-07-15T16:00:00.000Z");
      expect(todayLocalStr(now)).toBe("2026-07-16");
    });

    it("UTC 2026-07-15T16:30:00（＝香港時間 2026-07-16T00:30:00，任務描述嘅邊界例子）→ 香港日期係 2026-07-16", () => {
      const now = new Date("2026-07-15T16:30:00.000Z");
      expect(todayLocalStr(now)).toBe("2026-07-16");
    });

    it("跨月邊界：UTC 2026-07-31T16:00:00（＝香港時間 2026-08-01T00:00:00）", () => {
      const now = new Date("2026-07-31T16:00:00.000Z");
      expect(todayLocalStr(now)).toBe("2026-08-01");
    });
  });

  describe("greetingWord()——按香港時間時段", () => {
    it("香港時間 00:30（UTC 前一日 16:30）→ 未夠 12 點，「早晨」", () => {
      const now = new Date("2026-07-15T16:30:00.000Z"); // HK 07-16 00:30
      expect(greetingWord(now)).toBe("早晨");
    });

    it("香港時間 11:59 → 「早晨」（<12 點）", () => {
      const now = new Date("2026-07-15T03:59:00.000Z"); // HK 07-15 11:59
      expect(greetingWord(now)).toBe("早晨");
    });

    it("香港時間 12:00 → 「午安」", () => {
      const now = new Date("2026-07-15T04:00:00.000Z"); // HK 07-15 12:00
      expect(greetingWord(now)).toBe("午安");
    });

    it("香港時間 17:59 → 「午安」", () => {
      const now = new Date("2026-07-15T09:59:00.000Z"); // HK 07-15 17:59
      expect(greetingWord(now)).toBe("午安");
    });

    it("香港時間 18:00 → 「晚安」", () => {
      const now = new Date("2026-07-15T10:00:00.000Z"); // HK 07-15 18:00
      expect(greetingWord(now)).toBe("晚安");
    });

    it("香港時間 23:59 → 「晚安」", () => {
      const now = new Date("2026-07-15T15:59:00.000Z"); // HK 07-15 23:59
      expect(greetingWord(now)).toBe("晚安");
    });

    it("UTC 呢個時刻本身係另一個鐘（例如 UTC 上晝 9 點）都要跟 HK 唔跟 UTC——HK 17:00 應該係「午安」而唔係跟 UTC 9:00 都話「早晨」", () => {
      const now = new Date("2026-07-15T09:00:00.000Z"); // UTC 09:00＝HK 17:00
      expect(greetingWord(now)).toBe("午安"); // 如果錯用 UTC 小時（9<12）會答錯做「早晨」
    });
  });

  describe("currentMonthStr()——同 todayLocalStr() 一致嘅香港時區跨月邊界", () => {
    it("UTC 2026-07-31T16:30:00（＝香港時間 2026-08-01）→ 「2026-08」", () => {
      const now = new Date("2026-07-31T16:30:00.000Z");
      expect(currentMonthStr(now)).toBe("2026-08");
    });

    it("UTC 2026-07-31T15:59:00（＝香港時間 2026-07-31T23:59，未跨月）→ 「2026-07」", () => {
      const now = new Date("2026-07-31T15:59:00.000Z");
      expect(currentMonthStr(now)).toBe("2026-07");
    });
  });

  describe("addMonthsStr()——B8 月份切換 chip 用", () => {
    it("2026-07 -1 → 2026-06", () => {
      expect(addMonthsStr("2026-07", -1)).toBe("2026-06");
    });
    it("2026-07 +1 → 2026-08", () => {
      expect(addMonthsStr("2026-07", 1)).toBe("2026-08");
    });
    it("跨年：2026-01 -1 → 2025-12", () => {
      expect(addMonthsStr("2026-01", -1)).toBe("2025-12");
    });
    it("跨年：2026-12 +1 → 2027-01", () => {
      expect(addMonthsStr("2026-12", 1)).toBe("2027-01");
    });
  });
});
