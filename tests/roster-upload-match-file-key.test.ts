// WP-UPLOAD-AUTOFIX 個案 1（P2-版面重設計計劃.md §17.11）：更表檔名鍵
// 配盤——純函數單元測試（`src/lib/roster-upload/match.ts`），冧
// `rosterFileNameStem()`／`matchSiteByFileName()`／`resolveRosterUploadSite()`。
import { describe, it, expect } from "vitest";
import { rosterFileNameStem, matchSiteByFileName, resolveRosterUploadSite, type SiteCandidate } from "@/lib/roster-upload/match";

describe("WP-UPLOAD-AUTOFIX 個案 1：rosterFileNameStem()", () => {
  it("6 種真實檔名格式都正規化得啱", () => {
    expect(rosterFileNameStem("Roster - 3172 殷樺花園 - Aug 2026.xlsx")).toBe("3172 殷樺花園");
    expect(rosterFileNameStem("Roster - CTB 6907 莫測試 U09999 Aug 2026.xlsx")).toBe("CTB 6907 莫測試 U09999");
    expect(rosterFileNameStem("Roster - 免稅店 Aug 2026.xlsx")).toBe("免稅店");
    expect(rosterFileNameStem("Roster - 7754  Weave OL - Aug 2026.xlsx")).toBe("7754 Weave OL");
    expect(rosterFileNameStem("Roster - Wilson Patrol -  Aug 2026.xlsx")).toBe("Wilson Patrol");
    expect(rosterFileNameStem("Roster - 城巴車廠 - Aug 2026.xlsx")).toBe("城巴車廠");
  });
});

describe("WP-UPLOAD-AUTOFIX 個案 1：matchSiteByFileName()", () => {
  const candidates: SiteCandidate[] = [
    { id: "site-parent", canonicalName: "城巴車廠", aliases: [] },
    { id: "site-ic", canonicalName: "創富廠IC", aliases: [], rosterFileKeys: ["CTB 6907"] },
  ];

  it("檔名 stem 含鍵（唔分大小寫）→ 用嗰個盤", () => {
    expect(matchSiteByFileName("Roster - CTB 6907 莫測試 U09999 Aug 2026.xlsx", candidates)).toBe("site-ic");
    expect(matchSiteByFileName("Roster - ctb 6907 Aug 2026.xlsx", candidates)).toBe("site-ic");
  });

  it("冇任何盤嘅鍵撞中 → null", () => {
    expect(matchSiteByFileName("Roster - 城巴車廠 - Aug 2026.xlsx", candidates)).toBeNull();
  });

  it("空 roster_file_keys 唔會撞中任何檔名", () => {
    const c: SiteCandidate[] = [{ id: "x", canonicalName: "盤名", aliases: [], rosterFileKeys: [] }];
    expect(matchSiteByFileName("Roster - 盤名 - Aug 2026.xlsx", c)).toBeNull();
  });
});

describe("WP-UPLOAD-AUTOFIX 個案 1：resolveRosterUploadSite() 配盤優先次序", () => {
  // dev DB 實測：「城巴車廠」9 個子盤（一檔多子盤，citybus layout），
  // 呢度用返兩個先夠證明安全網嘅「childCount>1」門檻（唔止一個先算）。
  const parent: SiteCandidate = { id: "parent", canonicalName: "城巴車廠", aliases: [] };
  const child: SiteCandidate = { id: "child", canonicalName: "城巴-創富車廠", aliases: [], parentSiteId: "parent" };
  const child2: SiteCandidate = { id: "child2", canonicalName: "城巴-上環車廠", aliases: [], parentSiteId: "parent" };
  const ic: SiteCandidate = { id: "ic", canonicalName: "創富廠IC", aliases: [], rosterFileKeys: ["CTB 6907"] };
  const candidates = [parent, child, child2, ic];

  it("siteIdHint 永遠最優先，唔理檔名鍵定內容", () => {
    const r = resolveRosterUploadSite("Roster - CTB 6907 Aug 2026.xlsx", "hint-site", "城巴車廠", [], candidates);
    expect(r).toEqual({ siteId: "hint-site", matchedViaFileKey: false, fileKeyMatchedKey: null, parentNoSubSiteWarning: null });
  });

  it("鍵優先於檔內名——CTB 6907 檔內盤名寫「城巴車廠」但檔名鍵配去「創富廠IC」", () => {
    const r = resolveRosterUploadSite("Roster - CTB 6907 Aug 2026.xlsx", null, "城巴車廠", ["創富車廠"], candidates);
    expect(r.siteId).toBe("ic");
    expect(r.matchedViaFileKey).toBe(true);
    expect(r.fileKeyMatchedKey).toBe("CTB 6907");
    expect(r.parentNoSubSiteWarning).toBeNull();
  });

  it("冇檔名鍵撞中，跌返檔內盤名——有子盤資料（subSiteNames 非空）就照常掛母盤", () => {
    const r = resolveRosterUploadSite("Roster - 城巴車廠 - Aug 2026.xlsx", null, "城巴車廠", ["創富車廠", "上環城巴車廠"], candidates);
    expect(r.siteId).toBe("parent");
    expect(r.matchedViaFileKey).toBe(false);
    expect(r.parentNoSubSiteWarning).toBeNull();
  });

  it("母盤無子盤安全網：冚中有多過一個子盤（>1）嘅母盤但 subSiteNames 係空 → null＋警告，唔自動掛母盤", () => {
    const r = resolveRosterUploadSite("Roster - 未知檔.xlsx", null, "城巴車廠", [], candidates);
    expect(r.siteId).toBeNull();
    expect(r.matchedViaFileKey).toBe(false);
    expect(r.parentNoSubSiteWarning).toContain("城巴車廠");
    expect(r.parentNoSubSiteWarning).toContain("冇子盤資料");
  });

  it("驗收（dev DB 實測）：淨係得一個子盤嘅母盤（例如「HKU座頭」／子盤「HKU 醫學院」，兩個盤各自有獨立更表檔案，唔係一檔多子盤）唔觸發安全網——照常自動掛母盤", () => {
    const hkuParent: SiteCandidate = { id: "hku-parent", canonicalName: "HKU座頭", aliases: ["HKU 座頭"] };
    const hkuChild: SiteCandidate = { id: "hku-child", canonicalName: "HKU 醫學院", aliases: [], parentSiteId: "hku-parent" };
    const r = resolveRosterUploadSite("Roster - 9314 HKU座頭 C更 - Aug 2026.xlsx", null, "HKU 座頭", [], [hkuParent, hkuChild]);
    expect(r.siteId).toBe("hku-parent");
    expect(r.parentNoSubSiteWarning).toBeNull();
  });

  it("冚中一個冇子盤嘅盤——安全網唔觸發，照樣自動掛（例如「創富廠IC」本身冇子盤）", () => {
    const r = resolveRosterUploadSite("Roster - 創富廠IC - Aug 2026.xlsx", null, "創富廠IC", [], candidates);
    expect(r.siteId).toBe("ic");
    expect(r.parentNoSubSiteWarning).toBeNull();
  });

  it("完全對唔到（冇鍵、冇內容配對）→ null，冇警告", () => {
    const r = resolveRosterUploadSite("Roster - 唔存在嘅盤 - Aug 2026.xlsx", null, "唔存在嘅盤", [], candidates);
    expect(r).toEqual({ siteId: null, matchedViaFileKey: false, fileKeyMatchedKey: null, parentNoSubSiteWarning: null });
  });
});
