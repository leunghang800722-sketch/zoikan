// WP-RECONCILE-UI（§33）：對數頁／分診共用純函數——原因分類＋人話、相似保安員四種規則、連結、needs_boss 對應。
// 全部假名（測試甲…）／假工號（U9xxxx）／假電話。
import { describe, expect, it } from "vitest";
import {
  LINK,
  classifyReason,
  findSimilar,
  humanizeReasonPart,
  piiHidden,
  matchNeedsBossByPerson,
  matchNeedsBossForQuestion,
  personFromRow,
  surnameCharMatch,
  tel4,
  type GuardLite,
  type NeedsBossItem,
} from "@/components/reconcile/derive";

const P = { name: "甲測試", staffNo: "U90001", tel: "91230001" };
const G = (over: Partial<GuardLite> & { id: string; name_zh: string }): GuardLite => ({ staff_no: null, tel: null, status: "active", ...over });

describe("classifyReason／humanize", () => {
  it("逐句分類（「；」接埋嘅多句）", () => {
    const parts = classifyReason("上載未指定盤（site_id 未定），請先喺更表上載列表頁指定盤；雞頭碼「ZZ」對唔到任何雞頭，請先喺雞頭管理加碼／別名再重新解析；保安員未配對");
    expect(parts.map((p) => p.kind)).toEqual(["no_site", "broker_code", "guard"]);
    expect(parts[1]!.value).toBe("ZZ");
  });
  it("其餘種類", () => {
    const kinds = (s: string) => classifyReason(s)[0]!.kind;
    expect(kinds("子盤未定，歷史紀錄有多過一個候選，人手覆核並批量指定子盤（或者確認歸母盤）")).toBe("subsite_ambiguous");
    expect(kinds("子盤「測試A座」對唔到（或者未 reparse），請先喺「盤」管理掛好子盤再重新解析")).toBe("subsite_unmatched");
    expect(kinds("請假格推斷唔到屬邊個更別（Time 欄同同一行都冇夠訊號），人手覆核")).toBe("leave_shift");
    expect(kinds("更別未配對")).toBe("shift_type");
    expect(kinds("更種已作廢，請重新解析上載或者一鍵結算補更種")).toBe("voided_shift_type");
    expect(kinds("格仔日期 2026-10-01 唔係上載月份（2026-09），唔可以寫入")).toBe("out_of_month");
    expect(kinds("更表入面同一人同日同盤同更別出現多過一次（重複行），淨係第一行參與對數，人手覆核")).toBe("duplicate");
  });
  it("保安員未配對講明更表寫咗乜", () => {
    const [part] = classifyReason("保安員未配對");
    expect(humanizeReasonPart(part!, P)).toBe("更表寫「甲測試／U90001」，名冊搵唔到");
    expect(humanizeReasonPart(part!, { name: "甲測試", staffNo: "", tel: "" })).toBe("更表寫「甲測試」，名冊搵唔到");
    expect(humanizeReasonPart(part!, null)).toContain("冇寫姓名／工號");
  });
});

describe("相似保安員（四種規則，最多 3 個）", () => {
  const guards: GuardLite[] = [
    G({ id: "g1", name_zh: "甲測試" }), // 同名
    G({ id: "g2", name_zh: "丁測試", staff_no: "U90001" }), // 同工號
    G({ id: "g3", name_zh: "丙電話", tel: "65550001" }), // 電話尾 4（0001）
    G({ id: "g4", name_zh: "甲測丙" }), // 同姓（甲）＋一字（測）
    G({ id: "g5", name_zh: "己測試", staff_no: "U90011" }), // 無關
    G({ id: "g6", name_zh: "甲丁戊" }), // 同姓但冇相同字
  ];
  it("同名／同工號／電話尾 4／同姓一字各自命中", () => {
    const r = findSimilar(P, guards, 10);
    const why = Object.fromEntries(r.map((x) => [x.guard.id, x.why]));
    expect(why.g1).toContain("name");
    expect(why.g2).toEqual(["staff_no"]);
    expect(why.g3).toEqual(["tel4"]);
    expect(why.g4).toEqual(["surname_char"]);
    expect(why.g5).toBeUndefined();
  });
  it("最多 3 個，工號 > 同名 > 電話 > 同姓", () => {
    const r = findSimilar(P, guards);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.guard.id)).toEqual(["g2", "g1", "g3"]);
  });
  it("工號比對忽略大小寫／符號；former 號都認", () => {
    const r = findSimilar({ name: "", staffNo: "u-90001", tel: "" }, [G({ id: "x", name_zh: "A", staff_numbers: [{ number: "U90001", status: "former" }] })]);
    expect(r[0]?.why).toEqual(["staff_no"]);
  });
  it("冇相似", () => {
    expect(findSimilar({ name: "庚獨行", staffNo: "U90099", tel: "" }, guards)).toEqual([]);
  });
  it("同姓一字：只限中文名、姓要同、其餘至少一字同", () => {
    expect(surnameCharMatch("甲測試丙", "甲測試丁")).toBe(true);
    expect(surnameCharMatch("甲測試丙", "甲大文")).toBe(false);
    expect(surnameCharMatch("甲測試丙", "陳測試丙")).toBe(false);
    expect(surnameCharMatch("甲測試丙", "甲測試丙")).toBe(false);
    expect(surnameCharMatch("CHAN TAI", "CHAN TAM")).toBe(false);
  });
  it("tel4 只取尾 4 位數字", () => {
    expect(tel4("9123 4567")).toBe("4567");
    expect(tel4("123")).toBeNull();
  });
});

describe("連結", () => {
  it("每類目標", () => {
    expect(LINK.guardFix("2026-09-01")).toBe("/roster-uploads?tab=fix&month=2026-09");
    expect(LINK.guards("U90001")).toBe("/guards?q=U90001");
    expect(LINK.guards("甲測試")).toBe(`/guards?q=${encodeURIComponent("甲測試")}`);
    expect(LINK.newFromDocs("甲測試", "U90001")).toBe(`/guards/new-from-docs?name=${encodeURIComponent("甲測試")}&staff_no=U90001`);
    expect(LINK.newFromDocs("", "")).toBe("/guards/new-from-docs");
    expect(LINK.uploadFocus("2026-09", "up1")).toBe("/roster-uploads?month=2026-09&focus=up1");
    expect(LINK.sites("s1")).toBe("/sites?focus=s1");
    expect(LINK.sites(null)).toBe("/sites");
    expect(LINK.brokers("ZZ")).toBe("/brokers?focus=ZZ");
    expect(LINK.triage).toBe("/triage");
  });
});

describe("needs_boss 對應", () => {
  const items: NeedsBossItem[] = [
    { seq: "I001", cells: [{ site_label: "測試盤甲", cell_count: 3 }], total_cell_count: 3, reason: "名單同名多過一個", name_raw: "甲測試", staff_no_raw: "U90001" },
    { seq: "I002", cells: [{ site_label: "測試盤乙", cell_count: 5 }], total_cell_count: 5, reason: "名單冇呢個人", name_raw: "測試丙", staff_no_raw: null },
  ];
  it("按姓名＋工號", () => {
    expect(matchNeedsBossByPerson(personFromRow({ name_raw: " 甲測試 ", staff_no_raw: "u90001", tel_raw: null }), items)?.seq).toBe("I001");
    expect(matchNeedsBossByPerson({ name: "甲測試", staffNo: "U90099", tel: "" }, items)).toBeNull();
  });
  it("題目：seq／姓名／盤名＋格數", () => {
    expect(matchNeedsBossForQuestion({ title: "保安員配對要核實（測試盤乙，5 格）", summary: "x (I001)", identity_label: null }, items)?.seq).toBe("I001");
    expect(matchNeedsBossForQuestion({ title: "保安員配對要核實（測試盤乙，5 格）", summary: "x", identity_label: "測試丙" }, items)?.seq).toBe("I002");
    expect(matchNeedsBossForQuestion({ title: "保安員配對要核實（測試盤乙，5 格）", summary: "x", identity_label: null }, items)?.seq).toBe("I002");
    expect(matchNeedsBossForQuestion({ title: "保安員配對要核實（測試盤乙、測試盤甲，99 格）", summary: "x", identity_label: null }, items)).toBeNull();
    expect(matchNeedsBossForQuestion({ title: "x", summary: "y", identity_label: null }, [])).toBeNull();
  });
});

describe("冇權限睇姓名／工號", () => {
  it("欄位被剷走先算 hidden（null 唔算）", () => {
    expect(piiHidden({ id: "r", row_index: 1 })).toBe(true);
    expect(piiHidden({ id: "r", name_raw: null, staff_no_raw: null })).toBe(false);
    expect(piiHidden(null)).toBe(false);
  });
  it("原因人話唔講「冇寫」", () => {
    const [part] = classifyReason("保安員未配對");
    expect(humanizeReasonPart(part!, null, true)).toContain("冇權限睇姓名／工號");
    expect(humanizeReasonPart(part!, null, true)).not.toContain("冇寫");
  });
});
