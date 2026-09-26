// WP-ROSTER-UPLOAD Phase B-1（B1-1）：對數引擎純函數單元測試——
// `reconcileRosterUpload()`／`resolveLeaveShiftTypeIds()` 冇任何 DB
// 依賴，直接用合成物件測（唔使起 fixture／DB）。鐵則：合成 id 一律用
// `guard-a`/`site-x` 呢類代號，唔用任何似真名/真工號嘅字串。
//
// 七類逐類至少 2 個 case：match／roster_only／system_only／guard_diff／
// settlement_diff／shift_type_diff／unresolved；另外三個任務書明文要求
// 嘅情景：長工頂雞頭更（settlement_diff／match 各一）、同人同日兩更（唔
// 會被誤判做 shift_type_diff）、子盤（唔同子盤嘅同一日同代號唔會撞鍵）。
import { describe, it, expect } from "vitest";
import {
  reconcileRosterUpload,
  resolveLeaveShiftTypeIds,
  buildReconcileKey,
  buildUnresolvedKey,
  summarizeReconcile,
  type ReconcileRosterEntry,
  type ReconcileSystemEntry,
  type ReconcileUnresolvedEntry,
} from "@/lib/roster-upload/reconcile";

function roster(overrides: Partial<ReconcileRosterEntry> & Pick<ReconcileRosterEntry, "rowId" | "workDate" | "siteId" | "guardId" | "shiftTypeId">): ReconcileRosterEntry {
  return {
    codeKind: "shift",
    rawCode: "N",
    hours: null,
    leaveCode: null,
    shiftTypeInferred: false,
    settlementBrokerId: "broker-k",
    operationalBrokerId: "broker-k",
    settlementInferred: false,
    settlementReason: null,
    settlementWarning: null,
    ...overrides,
  };
}

function system(overrides: Partial<ReconcileSystemEntry> & Pick<ReconcileSystemEntry, "id" | "workDate" | "siteId" | "guardId" | "shiftTypeId">): ReconcileSystemEntry {
  return {
    settlementBrokerId: "broker-k",
    operationalBrokerId: "broker-k",
    recordType: "shift",
    leaveCode: null,
    status: "confirmed",
    source: null,
    ...overrides,
  };
}

describe("WP-ROSTER-UPLOAD Phase B-1：reconcileRosterUpload() 對數分類", () => {
  it("match case 1：人／更種／結算單位三者都同", () => {
    const r = roster({ rowId: "row-1", workDate: "2026-09-01", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const s = system({ id: "sr-1", workDate: "2026-09-01", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items).toHaveLength(1);
    expect(items[0]!.category).toBe("match");
    expect(items[0]!.key).toBe(buildReconcileKey({ workDate: "2026-09-01", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" }));
  });

  it("match case 2：OT 記錉（record_type=ot）都可以夾中", () => {
    const r = roster({ rowId: "row-ot1", workDate: "2026-09-02", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-ot", codeKind: "ot", rawCode: "OT2", hours: 2 });
    const s = system({ id: "sr-ot1", workDate: "2026-09-02", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-ot", recordType: "ot" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("match");
  });

  it("roster_only case 1：更表有、系統完全冇呢個安員呢日記錉", () => {
    const r = roster({ rowId: "row-2", workDate: "2026-09-03", siteId: "site-x", guardId: "guard-b", shiftTypeId: "st-day" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [] });
    expect(items[0]!.category).toBe("roster_only");
    expect(items[0]!.system).toBeNull();
  });

  it("roster_only case 2：leave 行（AL）系統完全未報", () => {
    const r = roster({ rowId: "row-al", workDate: "2026-09-04", siteId: "site-x", guardId: "guard-b", shiftTypeId: "st-day", codeKind: "leave", rawCode: "AL", leaveCode: "AL" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [] });
    expect(items[0]!.category).toBe("roster_only");
    expect(items[0]!.roster?.leaveCode).toBe("AL");
  });

  it("system_only case 1：系統有、更表完全冇（source=人手報更）", () => {
    const s = system({ id: "sr-2", workDate: "2026-09-05", siteId: "site-x", guardId: "guard-c", shiftTypeId: "st-day", source: "人手" });
    const items = reconcileRosterUpload({ rosterEntries: [], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("system_only");
    expect(items[0]!.system?.source).toBe("人手");
  });

  it("system_only case 2：source=null（現存記錉冇標記，見 B1-7 落差）一樣列到", () => {
    const s = system({ id: "sr-3", workDate: "2026-09-06", siteId: "site-x", guardId: "guard-c", shiftTypeId: "st-day", source: null });
    const items = reconcileRosterUpload({ rosterEntries: [], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("system_only");
    expect(items[0]!.system?.source).toBeNull();
  });

  it("guard_diff case 1：同日同盤同更種，更表話係 A、系統話係 B", () => {
    const r = roster({ rowId: "row-3", workDate: "2026-09-07", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const s = system({ id: "sr-4", workDate: "2026-09-07", siteId: "site-x", guardId: "guard-b", shiftTypeId: "st-day" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items).toHaveLength(1);
    expect(items[0]!.category).toBe("guard_diff");
    expect(items[0]!.roster?.guardId).toBe("guard-a");
    expect(items[0]!.system?.guardId).toBe("guard-b");
  });

  it("guard_diff case 2：夜更（唔同更種代號但同一個 shift_type_id）都一樣判 guard_diff", () => {
    const r = roster({ rowId: "row-3n", workDate: "2026-09-08", siteId: "site-x", guardId: "guard-d", shiftTypeId: "st-night", rawCode: "N" });
    const s = system({ id: "sr-4n", workDate: "2026-09-08", siteId: "site-x", guardId: "guard-e", shiftTypeId: "st-night" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("guard_diff");
  });

  it("guard_diff：多過一個候選唔估（留返 roster_only + system_only 分開列）", () => {
    // 同日同盤同更種，更表兩行（唔同人）、系統一條——冇辦法配對邊個換
    // 邊個，唔准估，跌返 roster_only(×2) + system_only(×1)。
    const r1 = roster({ rowId: "row-amb1", workDate: "2026-09-09", siteId: "site-x", guardId: "guard-f", shiftTypeId: "st-day" });
    const r2 = roster({ rowId: "row-amb2", workDate: "2026-09-09", siteId: "site-x", guardId: "guard-g", shiftTypeId: "st-day" });
    const s = system({ id: "sr-amb", workDate: "2026-09-09", siteId: "site-x", guardId: "guard-h", shiftTypeId: "st-day" });
    const items = reconcileRosterUpload({ rosterEntries: [r1, r2], unresolvedEntries: [], systemEntries: [s] });
    const cats = items.map((i) => i.category).sort();
    expect(cats).toEqual(["roster_only", "roster_only", "system_only"]);
  });

  it("settlement_diff case 1：人／更種都同，結算單位唔同", () => {
    const r = roster({ rowId: "row-4", workDate: "2026-09-10", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day", settlementBrokerId: "broker-w" });
    const s = system({ id: "sr-5", workDate: "2026-09-10", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day", settlementBrokerId: "broker-k" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("settlement_diff");
  });

  it("settlement_diff case 2：長工頂雞頭更——更表雞頭碼欄有值（settlement_inferred=false），同系統現存嘅 null 唔同", () => {
    // 規則 8：長工可以喺放假日頂雞頭更，結算單位＝雞頭（更表嗰行雞頭碼
    // 有值，settlementInferred=false）；系統舊記錉仲係冇結算單位（長工
    // autopay 冇雞頭），對數要標 settlement_diff 俾會計覆核，唔可以默
    // 默用返舊值。
    const r = roster({ rowId: "row-longterm", workDate: "2026-09-11", siteId: "site-x", guardId: "guard-longterm", shiftTypeId: "st-day", settlementBrokerId: "broker-w", settlementInferred: false });
    const s = system({ id: "sr-longterm", workDate: "2026-09-11", siteId: "site-x", guardId: "guard-longterm", shiftTypeId: "st-day", settlementBrokerId: null });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("settlement_diff");
    expect(items[0]!.roster?.settlementInferred).toBe(false);
  });

  it("長工頂雞頭更——兩邊結算單位一致就係 match（唔會因為係長工就強制判 diff）", () => {
    const r = roster({ rowId: "row-longterm2", workDate: "2026-09-12", siteId: "site-x", guardId: "guard-longterm", shiftTypeId: "st-day", settlementBrokerId: "broker-w" });
    const s = system({ id: "sr-longterm2", workDate: "2026-09-12", siteId: "site-x", guardId: "guard-longterm", shiftTypeId: "st-day", settlementBrokerId: "broker-w" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("match");
  });

  it("shift_type_diff case 1：同人同日同盤，更種唔同", () => {
    const r = roster({ rowId: "row-5", workDate: "2026-09-13", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const s = system({ id: "sr-6", workDate: "2026-09-13", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-night" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items).toHaveLength(1);
    expect(items[0]!.category).toBe("shift_type_diff");
  });

  it("shift_type_diff case 2：更表話呢日轉咗做 OT 更別，系統仲係正更", () => {
    const r = roster({ rowId: "row-5ot", workDate: "2026-09-14", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-ot", codeKind: "ot", rawCode: "OT1", hours: 1 });
    const s = system({ id: "sr-6ot", workDate: "2026-09-14", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const items = reconcileRosterUpload({ rosterEntries: [r], unresolvedEntries: [], systemEntries: [s] });
    expect(items[0]!.category).toBe("shift_type_diff");
  });

  it("同人同日兩更（唔同 shift_type_id）——兩邊都夾中，唔會誤判做 shift_type_diff", () => {
    // 一個安員同一日喺兩個唔同更別都有記錉（例如正更+另一行救更），逐更
    // 配對鍵含 shift_type_id，兩條應該分別各自 match，唔會因為「同人同
    // 日」就被第三輪 shift_type_diff 分組邏輯屈埋一齊。
    const r1 = roster({ rowId: "row-multi1", workDate: "2026-09-15", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const r2 = roster({ rowId: "row-multi2", workDate: "2026-09-15", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-night" });
    const s1 = system({ id: "sr-multi1", workDate: "2026-09-15", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day" });
    const s2 = system({ id: "sr-multi2", workDate: "2026-09-15", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-night" });
    const items = reconcileRosterUpload({ rosterEntries: [r1, r2], unresolvedEntries: [], systemEntries: [s1, s2] });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.category === "match")).toBe(true);
  });

  it("子盤：唔同（解析後）子盤嘅同一日同代號唔會撞鍵，各自獨立分類", () => {
    // 城巴車廠／CP5 一檔多子盤——resolvedSiteId 已經係「解析後實際
    // （子）盤」，兩個子盤即使 guard/shiftTypeId 湊巧撞埋都唔會互相
    // 干擾（siteId 係鍵嘅一部分）。
    const r1 = roster({ rowId: "row-sub1", workDate: "2026-09-16", siteId: "site-sub-1", guardId: "guard-a", shiftTypeId: "st-day" });
    const r2 = roster({ rowId: "row-sub2", workDate: "2026-09-16", siteId: "site-sub-2", guardId: "guard-a", shiftTypeId: "st-day" });
    const s1 = system({ id: "sr-sub1", workDate: "2026-09-16", siteId: "site-sub-1", guardId: "guard-a", shiftTypeId: "st-day" });
    // site-sub-2 嘅系統冇對應記錉——roster_only。
    const items = reconcileRosterUpload({ rosterEntries: [r1, r2], unresolvedEntries: [], systemEntries: [s1] });
    const bySite = new Map(items.map((i) => [i.siteId, i.category]));
    expect(bySite.get("site-sub-1")).toBe("match");
    expect(bySite.get("site-sub-2")).toBe("roster_only");
  });

  it("unresolved case 1：安員未配對（guard_id null）", () => {
    const u: ReconcileUnresolvedEntry = { rowId: "row-u1", workDate: "2026-09-17", siteId: "site-x", guardId: null, shiftTypeId: "st-day", codeKind: "shift", rawCode: "N", reason: "安員未配對" };
    const items = reconcileRosterUpload({ rosterEntries: [], unresolvedEntries: [u], systemEntries: [] });
    expect(items[0]!.category).toBe("unresolved");
    expect(items[0]!.key).toBe(buildUnresolvedKey("row-u1"));
  });

  it("unresolved case 2：更別未配對（shift_type_id null）", () => {
    const u: ReconcileUnresolvedEntry = { rowId: "row-u2", workDate: "2026-09-18", siteId: "site-x", guardId: "guard-a", shiftTypeId: null, codeKind: "shift", rawCode: "X", reason: "更別未配對" };
    const items = reconcileRosterUpload({ rosterEntries: [], unresolvedEntries: [u], systemEntries: [] });
    expect(items[0]!.category).toBe("unresolved");
  });

  it("unresolved case 3：子盤對唔到（resolved site null）", () => {
    const u: ReconcileUnresolvedEntry = { rowId: "row-u3", workDate: "2026-09-19", siteId: null, guardId: "guard-a", shiftTypeId: null, codeKind: "shift", rawCode: "N", reason: "子盤對唔到" };
    const items = reconcileRosterUpload({ rosterEntries: [], unresolvedEntries: [u], systemEntries: [] });
    expect(items[0]!.category).toBe("unresolved");
    expect(items[0]!.siteId).toBeNull();
  });

  it("summarizeReconcile：逐類數埋＋推算結算單位計數", () => {
    const r1 = roster({ rowId: "row-s1", workDate: "2026-09-20", siteId: "site-x", guardId: "guard-a", shiftTypeId: "st-day", settlementInferred: true });
    const r2 = roster({ rowId: "row-s2", workDate: "2026-09-21", siteId: "site-x", guardId: "guard-b", shiftTypeId: "st-day", settlementInferred: false });
    const items = reconcileRosterUpload({ rosterEntries: [r1, r2], unresolvedEntries: [], systemEntries: [] });
    const summary = summarizeReconcile(items);
    expect(summary.total).toBe(2);
    expect(summary.byCategory.roster_only).toBe(2);
    expect(summary.settlementInferredCount).toBe(1);
  });
});

describe("WP-ROSTER-UPLOAD Phase B-1（B1-4）：resolveLeaveShiftTypeIds() leave 行更別推斷", () => {
  const candidates = [
    { id: "st-day", siteId: "site-x", timeSlot: "0700-1900" },
    { id: "st-night", siteId: "site-x", timeSlot: "1900-0700" },
  ];

  it("訊號 1：該行 Time 欄啱好夾中淨一個 shift_type", () => {
    const rows = [{ id: "row-leave-time", rowIndex: 10, codeKind: "leave", shiftTypeId: null, timeRaw: "0700-1900", effectiveSiteId: "site-x" }];
    const result = resolveLeaveShiftTypeIds(rows, candidates);
    expect(result.get("row-leave-time")).toEqual({ shiftTypeId: "st-day", inferred: true });
  });

  it("訊號 2：Time 欄冇/夾唔中，跌返同一行（rowIndex）其他日子嘅正更多數票", () => {
    const rows = [
      { id: "row-shift-1", rowIndex: 20, codeKind: "shift", shiftTypeId: "st-night", timeRaw: null, effectiveSiteId: "site-x" },
      { id: "row-shift-2", rowIndex: 20, codeKind: "shift", shiftTypeId: "st-night", timeRaw: null, effectiveSiteId: "site-x" },
      { id: "row-leave-row", rowIndex: 20, codeKind: "leave", shiftTypeId: null, timeRaw: null, effectiveSiteId: "site-x" },
    ];
    const result = resolveLeaveShiftTypeIds(rows, candidates);
    expect(result.get("row-leave-row")).toEqual({ shiftTypeId: "st-night", inferred: true });
  });

  it("兩層訊號都搵唔到——留 null，call site 會將呢行列做 unresolved（唔估）", () => {
    const rows = [{ id: "row-leave-none", rowIndex: 30, codeKind: "leave", shiftTypeId: null, timeRaw: "9999-9999", effectiveSiteId: "site-x" }];
    const result = resolveLeaveShiftTypeIds(rows, candidates);
    expect(result.get("row-leave-none")).toEqual({ shiftTypeId: null, inferred: false });
  });

  it("已經有 shift_type_id（理論上唔會發生，但輸入有嘅話直接尊重，唔重推）", () => {
    const rows = [{ id: "row-leave-has", rowIndex: 40, codeKind: "leave", shiftTypeId: "st-day", timeRaw: null, effectiveSiteId: "site-x" }];
    const result = resolveLeaveShiftTypeIds(rows, candidates);
    expect(result.get("row-leave-has")).toEqual({ shiftTypeId: "st-day", inferred: false });
  });
});
