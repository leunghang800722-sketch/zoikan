// P7.1：cron 解析＋下次執行時間（香港時間）。
import { describe, it, expect } from "vitest";
import { nextRun, parseCron, isValidCron } from "@/lib/scheduler/cron";
import { hkParts, hkNextMonthStart, hkDateStr } from "@/lib/dates";

const hk = (s: string) => new Date(`${s}+08:00`); // "2026-10-11T21:00:00"

describe("P7.1 cron", () => {
  it("每日 21:00 HKT：之前→當日；剛過→翌日", () => {
    expect(nextRun("0 21 * * *", hk("2026-10-11T20:59:30"))).toEqual(hk("2026-10-11T21:00:00"));
    expect(nextRun("0 21 * * *", hk("2026-10-11T21:00:00"))).toEqual(hk("2026-10-12T21:00:00")); // 嚴格晚過
    expect(nextRun("0 21 * * *", hk("2026-10-11T21:00:01"))).toEqual(hk("2026-10-12T21:00:00"));
  });
  it("UTC 日界：香港 09:00 = UTC 01:00，香港凌晨仍屬香港當日", () => {
    expect(nextRun("0 9 * * *", new Date("2026-10-10T17:30:00Z"))).toEqual(hk("2026-10-11T09:00:00")); // HK 01:30 on 11th
  });
  it("每月 25 號 09:00 跨月／跨年", () => {
    expect(nextRun("0 9 25 * *", hk("2026-10-11T00:00:00"))).toEqual(hk("2026-10-25T09:00:00"));
    expect(nextRun("0 9 25 * *", hk("2026-10-25T09:00:00"))).toEqual(hk("2026-11-25T09:00:00"));
    expect(nextRun("0 9 25 * *", hk("2026-12-25T09:00:01"))).toEqual(hk("2027-01-25T09:00:00"));
  });
  it("星期、step、list、range", () => {
    expect(nextRun("0 9 * * 1", hk("2026-10-11T10:00:00"))).toEqual(hk("2026-10-12T09:00:00")); // 2026-10-11 係星期日，翌日星期一
    expect(nextRun("*/15 * * * *", hk("2026-10-11T10:07:00"))).toEqual(hk("2026-10-11T10:15:00"));
    expect(nextRun("0,30 8-9 * * *", hk("2026-10-11T08:30:00"))).toEqual(hk("2026-10-11T09:00:00"));
    expect(nextRun("0 9 * * 7", hk("2026-10-10T10:00:00"))).toEqual(hk("2026-10-11T09:00:00")); // 7＝星期日
  });
  it("唔存在嘅日子（2 月 31 號）回 null；非法 cron 拋錯", () => {
    expect(nextRun("0 9 31 2 *", hk("2026-10-11T00:00:00"))).toBeNull();
    expect(() => parseCron("0 9 * *")).toThrow();
    expect(isValidCron("61 * * * *")).toBe(false);
    expect(isValidCron("0 9 25 * *")).toBe(true);
  });
  it("hkParts／hkNextMonthStart／hkDateStr", () => {
    expect(hkParts(new Date("2026-10-31T16:30:00Z"))).toMatchObject({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 });
    expect(hkNextMonthStart(new Date("2026-10-31T16:30:00Z")).toISOString().slice(0, 10)).toBe("2026-12-01");
    expect(hkNextMonthStart(new Date("2026-12-25T01:00:00Z")).toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(hkDateStr(new Date("2026-10-11T16:00:00Z"))).toBe("2026-10-12");
  });
});
