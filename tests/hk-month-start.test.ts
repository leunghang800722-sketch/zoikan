// P3-0.5（B-7）：預設月份按香港日曆，唔係 UTC。
import { describe, it, expect } from "vitest";
import { hkMonthStart } from "@/lib/dates";

describe("hkMonthStart", () => {
  it("2026-10-31T17:00:00Z（香港 11 月 1 日 01:00）→ 2026-11-01", () => {
    expect(hkMonthStart(new Date("2026-10-31T17:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-01");
  });
  it("2026-10-31T15:59:59Z（香港 10 月 31 日 23:59）→ 2026-10-01", () => {
    expect(hkMonthStart(new Date("2026-10-31T15:59:59Z")).toISOString().slice(0, 10)).toBe("2026-10-01");
  });
  it("跨年：2026-12-31T16:00:00Z（香港 2027-01-01 00:00）→ 2027-01-01", () => {
    expect(hkMonthStart(new Date("2026-12-31T16:00:00Z")).toISOString().slice(0, 10)).toBe("2027-01-01");
  });
  it("月中不變", () => {
    expect(hkMonthStart(new Date("2026-10-15T04:00:00Z")).toISOString().slice(0, 10)).toBe("2026-10-01");
  });
});
