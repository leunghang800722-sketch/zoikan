// WP-GUARD-FIX（老闆 2026-09-25 要求）：「安員別名」配對——純函數單元
// 測試（`src/lib/roster-upload/match.ts` `buildGuardMatchIndex()`／
// `matchGuard()`）。全部姓名／電話／工號都係虛構測試值，唔可以出現真名
// （鐵則）。配對次序：(1) 工號 →(2) 姓名＋電話 →(2b) 別名＋電話 →(3)
// 姓名唯一 →(3b) 別名唯一。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex, matchGuard, type GuardMatchIndex } from "@/lib/roster-upload/match";

function mkIndex(
  guards: Array<{ id: string; nameZh: string; tel?: string | null; staffNo?: string | null; staffNoMw?: string | null; nameAliases?: string[] }>,
): GuardMatchIndex {
  return buildGuardMatchIndex({
    guards: guards.map((g) => ({
      id: g.id,
      nameZh: g.nameZh,
      tel: g.tel ?? null,
      staffNo: g.staffNo ?? null,
      staffNoMw: g.staffNoMw ?? null,
      nameAliases: g.nameAliases ?? [],
    })),
    staffNumbers: [],
    phones: [],
  });
}

describe("WP-GUARD-FIX：別名＋電話 (2b)", () => {
  it("姓名＋電話冧唔到，別名＋電話撞中一個 → matchedViaAlias=true", () => {
    const index = mkIndex([{ id: "g1", nameZh: "測試甲", tel: "91234567", nameAliases: ["阿甲"] }]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "阿甲", telRaw: "91234567" }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_name_tel", matchedViaAlias: true });
  });

  it("電話唔啱，(2b) 冧唔到，但跌落 (3b) 別名唯一（同 (3) 姓名唯一一致寬鬆度，唔使電話）—— DB 得一個人用呢個別名一樣配到，matchedViaAlias=true", () => {
    const index = mkIndex([{ id: "g1", nameZh: "測試甲", tel: "91234567", nameAliases: ["阿甲"] }]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "阿甲", telRaw: "90000000" }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_name", matchedViaAlias: true });
  });

  it("兩個人用同一個別名＋同一個電話（極罕見打錯）→ ambiguous", () => {
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲", tel: "91234567", nameAliases: ["阿甲"] },
      { id: "g2", nameZh: "測試乙", tel: "91234567", nameAliases: ["阿甲"] },
    ]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "阿甲", telRaw: "91234567" }, index);
    expect(r).toMatchObject({ guardId: null, guardMatch: "ambiguous" });
  });
});

describe("WP-GUARD-FIX：別名唯一 (3b)", () => {
  it("姓名唯一冧唔到（名冧唔到任何人），別名喺 DB 淨係一個人有 → matchedViaAlias=true", () => {
    const index = mkIndex([{ id: "g1", nameZh: "測試甲", nameAliases: ["阿甲花名"] }]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "阿甲花名", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_name", matchedViaAlias: true });
  });

  it("多過一個人有同一個別名 → ambiguous，唔准估", () => {
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲", nameAliases: ["阿明"] },
      { id: "g2", nameZh: "測試乙", nameAliases: ["阿明"] },
    ]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "阿明", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: null, guardMatch: "ambiguous" });
  });

  it("本名配對優先過別名——本名撞中就唔會行到別名嗰步", () => {
    // g2 個別名同 g1 個本名撞埋，但姓名比對 (2)/(3) 一定行先，g1 本名
    // 唯一命中，唔會被 g2 個別名分薄。
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲" },
      { id: "g2", nameZh: "測試乙", nameAliases: ["測試甲"] },
    ]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_name", matchedViaAlias: false });
  });
});

describe("WP-GUARD-FIX（實測揭發，dev DB 驗證時撞到）：B1-8 姓名核對要本名／別名都試", () => {
  it("工號命中一個人，更表姓名係佢個別名（唔係本名）→ 唔可以誤判『工號屬另一人』", () => {
    const index = buildGuardMatchIndex({
      guards: [{ id: "g1", nameZh: "測試甲", tel: null, staffNo: "U88880002", staffNoMw: null, nameAliases: ["阿甲花名"] }],
      staffNumbers: [{ number: "U88880002", guardId: "g1", status: "current" }],
      phones: [],
    });
    const r = matchGuard({ staffNoRaw: "U88880002", nameRaw: "阿甲花名", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_staff_no", staffNoBelongsToOther: false, matchedViaAlias: true });
  });

  it("工號命中一個人，更表姓名本名／別名都唔係 → 仍然係『工號屬另一人』", () => {
    const index = buildGuardMatchIndex({
      guards: [{ id: "g1", nameZh: "測試甲", tel: null, staffNo: "U88880003", staffNoMw: null, nameAliases: ["阿甲花名"] }],
      staffNumbers: [{ number: "U88880003", guardId: "g1", status: "current" }],
      phones: [],
    });
    const r = matchGuard({ staffNoRaw: "U88880003", nameRaw: "完全第二個名", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: null, guardMatch: "ambiguous", staffNoBelongsToOther: true });
  });
});

describe("WP-GUARD-FIX：工號配對優先過別名", () => {
  it("工號命中就唔會行到別名（就算姓名寫嘅係第二個人嘅別名都好，姓名核對唔夾先會 ambiguous）", () => {
    const index = buildGuardMatchIndex({
      guards: [{ id: "g1", nameZh: "測試甲", tel: null, staffNo: "U88880001", staffNoMw: null, nameAliases: [] }],
      staffNumbers: [{ number: "U88880001", guardId: "g1", status: "current" }],
      phones: [],
    });
    const r = matchGuard({ staffNoRaw: "U88880001", nameRaw: "測試甲", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_staff_no", matchedViaAlias: false });
  });
});

describe("WP-GUARD-FIX：buildGuardMatchIndex() 冇 nameAliases 都得（backward compatible）", () => {
  it("call site 唔傳 nameAliases（好似 scripts/opening/build-aug-plan.ts）—— byAlias 就係空，唔會影響原有配對", () => {
    const index = buildGuardMatchIndex({
      guards: [{ id: "g1", nameZh: "測試甲", tel: "91234567", staffNo: null, staffNoMw: null }],
      staffNumbers: [],
      phones: [],
    });
    expect(index.byAlias.size).toBe(0);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: "91234567" }, index);
    expect(r).toMatchObject({ guardId: "g1", guardMatch: "by_name_tel", matchedViaAlias: false });
  });
});
