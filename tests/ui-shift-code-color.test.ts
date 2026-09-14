// WP-R2 Opus 驗收第 1 項：RD／SH 喺 LEAVE_CODES 入面，但唔可以畀
// isLeave 蓋過 FIXED 配色（README §04：RD `#f1f5f9`/`#64748b`、SH
// `#ccfbf1`/`#0f766e`）。覆蓋優先次序：isDraft ＞ FIXED ＞ isLeave ＞
// NEUTRAL。
import { describe, expect, it } from "vitest";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";

describe("shiftCodeStyle", () => {
  it("RD 即使 isLeave=true 都要用 FIXED 配色（灰），唔係橙虛線", () => {
    const s = shiftCodeStyle("RD", { isLeave: true });
    expect(s.bg).toBe("#f1f5f9");
    expect(s.fg).toBe("#64748b");
    expect(s.border).toBeUndefined();
  });

  it("SH 即使 isLeave=true 都要用 FIXED 配色（青），唔係橙虛線", () => {
    const s = shiftCodeStyle("SH", { isLeave: true });
    expect(s.bg).toBe("#ccfbf1");
    expect(s.fg).toBe("#0f766e");
    expect(s.border).toBeUndefined();
  });

  it("D／N 唔理 isLeave 都係用 FIXED 配色", () => {
    expect(shiftCodeStyle("D", { isLeave: false })).toEqual({ bg: "#dbeafe", fg: "#1e40af" });
    expect(shiftCodeStyle("N", { isLeave: true })).toEqual({ bg: "#e0e7ff", fg: "#3730a3" });
  });

  it("AL（唔喺 FIXED 表）isLeave=true 要用橙虛線 LEAVE 樣式", () => {
    const s = shiftCodeStyle("AL", { isLeave: true });
    expect(s.bg).toBe("#fff");
    expect(s.fg).toBe("#b45309");
    expect(s.border).toBe("1px dashed #f59e0b");
  });

  it("SL／NL／OFF／NPL（其餘請假代號）都要用橙虛線 LEAVE 樣式", () => {
    for (const code of ["SL", "NL", "OFF", "NPL"]) {
      const s = shiftCodeStyle(code, { isLeave: true });
      expect(s.border).toBe("1px dashed #f59e0b");
      expect(s.fg).toBe("#b45309");
    }
  });

  it("draft 優先於一切——RD／SH／D／AL 喺 isDraft=true 下都變返同一款透明虛線藍框", () => {
    for (const code of ["RD", "SH", "D", "AL", "N"]) {
      const s = shiftCodeStyle(code, { isLeave: true, isDraft: true });
      expect(s).toEqual({ bg: "transparent", fg: "#1e40af", border: "1px dashed #2563eb" });
    }
  });

  it("draft 優先於 isLeave=false 嘅情況（例如 D／N 本身 draft 都要變虛線）", () => {
    const s = shiftCodeStyle("D", { isDraft: true });
    expect(s.border).toBe("1px dashed #2563eb");
  });

  it("非 FIXED、非 leave 嘅代號（例如 IC）用中性色", () => {
    const s = shiftCodeStyle("IC", {});
    expect(s).toEqual({ bg: "#f1f5f9", fg: "#475569" });
  });

  it("空代號回傳透明", () => {
    expect(shiftCodeStyle(null)).toEqual({ bg: "transparent", fg: "transparent" });
    expect(shiftCodeStyle(undefined)).toEqual({ bg: "transparent", fg: "transparent" });
    expect(shiftCodeStyle("")).toEqual({ bg: "transparent", fg: "transparent" });
  });

  it("代號小寫都要 match 得到 FIXED（大小寫唔敏感）", () => {
    expect(shiftCodeStyle("rd", { isLeave: true })).toEqual({ bg: "#f1f5f9", fg: "#64748b" });
  });
});
