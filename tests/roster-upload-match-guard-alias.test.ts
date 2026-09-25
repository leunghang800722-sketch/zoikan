// WP-GUARD-FIX（老闆 2026-09-25 要求）：「安員別名」配對——純函數單元
// 測試（`src/lib/roster-upload/match.ts` `buildGuardMatchIndex()`／
// `matchGuard()`）。全部姓名／電話／工號都係虛構測試值，唔可以出現真名
// （鐵則）。配對次序：(1) 工號 →(2) 姓名∪別名＋電話 →(3) 姓名∪別名
// 唯一（驗收 Opus 5.5：本名同別名候選合埋計，多過一個人就 ambiguous）。
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

  it("驗收（Opus 5.5）：A 嘅別名等於 B 嘅本名、冇電話 → ambiguous（之前本名步驟先行，會靜靜配咗俾 B）", () => {
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲" },
      { id: "g2", nameZh: "測試乙", nameAliases: ["測試甲"] },
    ]);
    const r = matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: null, guardMatch: "ambiguous", matchedViaAlias: false });
  });

  it("驗收（Opus 5.5）：A 嘅別名等於 B 嘅本名，但電話分到（行電話＝A 嘅）→ 配 A（由別名），唔係 B", () => {
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲", tel: "91110001" },
      { id: "g2", nameZh: "測試乙", tel: "91110002", nameAliases: ["測試甲"] },
    ]);
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: "91110002" }, index)).toMatchObject({ guardId: "g2", guardMatch: "by_name_tel", matchedViaAlias: true });
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: "91110001" }, index)).toMatchObject({ guardId: "g1", guardMatch: "by_name_tel", matchedViaAlias: false });
  });

  it("驗收（Opus 5.5）：A 嘅別名等於 B 嘅本名，而且兩個共用同一個電話（家人電話）→ ambiguous", () => {
    const index = mkIndex([
      { id: "g1", nameZh: "測試甲", tel: "91110003" },
      { id: "g2", nameZh: "測試乙", tel: "91110003", nameAliases: ["測試甲"] },
    ]);
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試甲", telRaw: "91110003" }, index)).toMatchObject({ guardId: null, guardMatch: "ambiguous" });
  });

  it("驗收（Opus 5.5）：工號屬 B、行名係 A 嘅本名、A 唔係 B 嘅別名 → 仍然『工號屬另一人』唔配（就算 A 喺 DB 存在）", () => {
    const index = buildGuardMatchIndex({
      guards: [
        { id: "gA", nameZh: "測試甲", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
        { id: "gB", nameZh: "測試乙", tel: null, staffNo: "U88880009", staffNoMw: null, nameAliases: ["阿乙"] },
      ],
      staffNumbers: [{ number: "U88880009", guardId: "gB", status: "current" }],
      phones: [],
    });
    const r = matchGuard({ staffNoRaw: "U88880009", nameRaw: "測試甲", telRaw: null }, index);
    expect(r).toMatchObject({ guardId: null, guardMatch: "ambiguous", staffNoBelongsToOther: true, matchedViaAlias: false });
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
