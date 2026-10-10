// P3-3.5：更表上載列表「有嘢要做」過濾。
import { describe, expect, it } from "vitest";
import { needsAction, type NeedsActionEntry } from "@/lib/roster-upload/needs-action";
import { CATEGORY_LABEL } from "@/lib/roster-upload/category-labels";

const mk = (over: Partial<NeedsActionEntry> & { status?: string; unmatched?: number; ambiguous?: number } = {}): NeedsActionEntry => ({
  site_id: over.site_id === undefined ? "s1" : over.site_id,
  upload: over.upload === undefined ? { status: over.status ?? "confirmed", parse_summary: { unmatched_guard_count: over.unmatched ?? 0, ambiguous_guard_count: over.ambiguous ?? 0 } } : over.upload,
});

describe("needsAction（P3-3.5）", () => {
  it("未上載 → 摺埋", () => expect(needsAction(mk({ upload: null }))).toBe(false));
  it("已對數確認＋冇未配對 → 摺埋", () => expect(needsAction(mk())).toBe(false));
  it("解析失敗／未對數（uploaded、parsed）→ 有嘢要做", () => {
    for (const status of ["parse_failed", "uploaded", "parsed"]) expect(needsAction(mk({ status }))).toBe(true);
  });
  it("已確認但仲有未配對或多重配對 → 有嘢要做", () => {
    expect(needsAction(mk({ unmatched: 2 }))).toBe(true);
    expect(needsAction(mk({ ambiguous: 1 }))).toBe(true);
  });
  it("盤名未配對（site_id null）→ 有嘢要做", () => expect(needsAction(mk({ site_id: null }))).toBe(true));
});

describe("對數分類中文 label", () => {
  it("七類全部有中文，冇英文 key 漏出", () => {
    for (const v of Object.values(CATEGORY_LABEL)) expect(v).toMatch(/[一-鿿]/);
    expect(CATEGORY_LABEL.roster_only).toBe("更表有・系統冇");
    expect(CATEGORY_LABEL.settlement_diff).toBe("結算單位唔同");
  });
});
