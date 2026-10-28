// HIST-2：OT1hr／OT2hrs／OT1h 當 OT 代號（HKU 座頭 1–3 月寫法）。
import { describe, it, expect } from "vitest";
import { classifyCode, otHoursFromCode } from "@/lib/roster-upload/cell-codes";

describe("OT<n>hr 代號", () => {
  it.each([["OT1hr", 1], ["OT2hrs", 2], ["ot1H", 1], ["OT3.5h", 3.5], ["OT1", 1], ["OT2.5", 2.5]])("%s → ot, %s 小時", (code, h) => {
    expect(classifyCode(code)).toBe("ot");
    expect(otHoursFromCode(code)).toBe(h);
  });
  it("唔似 OT 嘅仍然 unknown", () => {
    for (const c of ["OThr", "OT1hrx", "OT-1", "xx"]) expect(classifyCode(c)).toBe("unknown");
  });
});
