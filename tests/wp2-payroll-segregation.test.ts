// P1-WP2 §D：硬性規則2（設計文件§5.1）「同一用戶不可同時係糧務批次嘅
// 入數人同批核人」——payout_batches 本身 P3 先做，呢度先鎖住 helper。
import { describe, it, expect } from "vitest";
import { assertDifferentActorApprover, SameActorPayoutError } from "@/lib/payroll-segregation";

describe("WP2 糧務入數人≠批核人 helper", () => {
  it("入數人同批核人係同一個用戶——拋錯", () => {
    expect(() => assertDifferentActorApprover("user-1", "user-1")).toThrow(SameActorPayoutError);
  });

  it("入數人同批核人係唔同用戶——唔拋錯", () => {
    expect(() => assertDifferentActorApprover("user-1", "user-2")).not.toThrow();
  });

  it("SameActorPayoutError 係 409", () => {
    try {
      assertDifferentActorApprover("u", "u");
      expect.fail("應該拋錯");
    } catch (e) {
      expect(e).toBeInstanceOf(SameActorPayoutError);
      expect((e as SameActorPayoutError).status).toBe(409);
    }
  });
});
