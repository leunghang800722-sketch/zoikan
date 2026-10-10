// P3-3.2：共用月份選擇器——來源次序（URL → sessionStorage → 預設）、sessionStorage 讀寫、URL 同步。
import { describe, expect, it } from "vitest";
import { MONTH_STORAGE_KEY, hrefWithMonth, isValidMonth, readStoredMonth, resolveMonth, writeStoredMonth, type MonthStorageLike } from "@/lib/ui/month-store";

function memStorage(init: Record<string, string> = {}): MonthStorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => void (data[k] = v) };
}

describe("month-store（P3-3.2）", () => {
  it("來源次序：URL 贏 sessionStorage 贏 預設", () => {
    expect(resolveMonth({ urlMonth: "2026-09", storedMonth: "2026-08", fallback: "2026-10" })).toEqual({ month: "2026-09", source: "url" });
    expect(resolveMonth({ urlMonth: null, storedMonth: "2026-08", fallback: "2026-10" })).toEqual({ month: "2026-08", source: "storage" });
    expect(resolveMonth({ urlMonth: null, storedMonth: null, fallback: "2026-10" })).toEqual({ month: "2026-10", source: "default" });
  });

  it("URL／storage 值非法（亂填）就當冇，順序落下一層", () => {
    expect(resolveMonth({ urlMonth: "2026-13", storedMonth: "2026-08", fallback: "2026-10" }).month).toBe("2026-08");
    expect(resolveMonth({ urlMonth: "abc", storedMonth: "xx", fallback: "2026-10" }).month).toBe("2026-10");
    expect(isValidMonth("2026-00")).toBe(false);
    expect(isValidMonth("2026-12")).toBe(true);
    expect(isValidMonth("")).toBe(false);
  });

  it("sessionStorage 寫入用 key zk.month；只收合法月份；讀返出嚟", () => {
    const st = memStorage();
    writeStoredMonth(st, "2026-09");
    expect(st.data[MONTH_STORAGE_KEY]).toBe("2026-09");
    expect(MONTH_STORAGE_KEY).toBe("zk.month");
    writeStoredMonth(st, "garbage");
    expect(st.data[MONTH_STORAGE_KEY]).toBe("2026-09");
    expect(readStoredMonth(st)).toBe("2026-09");
    expect(readStoredMonth(memStorage({ "zk.month": "bad" }))).toBeNull();
  });

  it("storage 拋錯（私隱模式）唔會令頁面爆", () => {
    const boom: MonthStorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredMonth(boom)).toBeNull();
    expect(() => writeStoredMonth(boom, "2026-09")).not.toThrow();
    expect(readStoredMonth(null)).toBeNull();
  });

  it("URL 同步：加／換 ?month=，保留其他 query 同 hash；同值唔改", () => {
    expect(hrefWithMonth("/reports/payroll", "2026-09")).toBe("/reports/payroll?month=2026-09");
    expect(hrefWithMonth("/roster-uploads?tab=fix", "2026-09")).toBe("/roster-uploads?tab=fix&month=2026-09");
    expect(hrefWithMonth("/x?month=2026-08&broker=A#h", "2026-09")).toBe("/x?month=2026-09&broker=A#h");
    expect(hrefWithMonth("/x?month=2026-09", "2026-09")).toBe("/x?month=2026-09");
  });
});
