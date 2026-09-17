// WP-PII（Opus 驗收應修 3）：maskHkid() fail-closed——格式唔啱一律回
// `"***"`（唔畀睇到原值），null/undefined/空字串一律回 null。
import { describe, it, expect } from "vitest";
import { maskHkid } from "@/lib/api/guard-pii";

describe("WP-PII 應修 3：maskHkid() fail-closed", () => {
  it("標準格式：遮走中間 3 位", () => {
    expect(maskHkid("A123456(7)")).toBe("A123***(7)");
    expect(maskHkid("AB123456(A)")).toBe("AB123***(A)");
  });

  it("null/undefined/空字串：回 null（「冇資料」唔算敏感，唔使遮）", () => {
    expect(maskHkid(null)).toBeNull();
    expect(maskHkid(undefined)).toBeNull();
    expect(maskHkid("")).toBeNull();
    expect(maskHkid("   ")).toBeNull();
  });

  it("格式意外（唔跟寬鬆 regex）：fail-closed 回 \"***\"，唔係原值", () => {
    expect(maskHkid("唔啱格式")).toBe("***");
    expect(maskHkid("123456789")).toBe("***");
    expect(maskHkid("A1234567(8)")).toBe("***"); // 多咗一位數字
  });

  it("非字串（型別意外）：fail-closed 回 \"***\"", () => {
    expect(maskHkid(12345)).toBe("***");
    expect(maskHkid({ hkid: "A123456(7)" })).toBe("***");
  });
});
