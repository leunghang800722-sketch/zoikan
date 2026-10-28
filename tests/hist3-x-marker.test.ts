// HIST-3 目標 5：格仔 x／X ＝ 空缺標記（marker），唔計更、唔係 unknown。
import { describe, it, expect } from "vitest";
import { classifyCode } from "@/lib/roster-upload/cell-codes";

describe("cell-codes：x 空缺標記", () => {
  it("x／X／帶空白都係 marker", () => {
    expect(classifyCode("x")).toBe("marker");
    expect(classifyCode("X")).toBe("marker");
    expect(classifyCode(" x ")).toBe("marker");
  });
  it("其他代號不變（回歸）", () => {
    expect(classifyCode("C")).toBe("shift");
    expect(classifyCode("XX")).toBe("unknown");
    expect(classifyCode("OT1hr")).toBe("ot");
  });
});
