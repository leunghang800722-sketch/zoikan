// WP-POSTORDER-FREE（§34 C）：月結頁 ④「冇 Postorder 都計到」一行字嘅純函數。
import { describe, it, expect } from "vitest";
import { dependencyLine } from "@/components/month-close/derive";
import type { PostorderDependencyDTO } from "@/components/month-close/types";

const dep = (over: Partial<PostorderDependencyDTO["pricing"]> = {}, sOver: Partial<PostorderDependencyDTO["settlement"]> = {}): PostorderDependencyDTO => ({
  pricing: { total: 200, unpriced: 20, by_step: { "1": 10, "2": 40, "3": 0, "4": 0, "5": 0, existing: 130 }, without_postorder: 140, ...over },
  settlement: { total: 200, by_reason: { roster: 180, postorder: 10, unresolved: 2 }, without_postorder: 188, ...sOver },
});

describe("dependencyLine", () => {
  it("砌出『價錢：N／M 更唔靠 Postorder 都計到（X%）；雞頭歸屬：N／M（Y%）』", () => {
    const l = dependencyLine(dep())!;
    expect(l.price).toBe("價錢：140／200 更唔靠 Postorder 都計到（70%）");
    expect(l.settle).toBe("雞頭歸屬：188／200（94%）");
    expect(l.pricePct).toBe(70);
    expect(l.settlePct).toBe(94);
  });
  it("舊 report（冇欄）或者兩邊總數 0 → null（唔顯示）", () => {
    expect(dependencyLine(undefined)).toBeNull();
    expect(dependencyLine(null)).toBeNull();
    expect(dependencyLine(dep({ total: 0, without_postorder: 0 }, { total: 0, without_postorder: 0 }))).toBeNull();
  });
  it("一邊總數 0 唔會除以 0", () => {
    const l = dependencyLine(dep({ total: 0, without_postorder: 0 }))!;
    expect(l.pricePct).toBe(0);
  });
});
