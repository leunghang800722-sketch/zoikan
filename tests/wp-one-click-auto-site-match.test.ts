// WP-ONE-CLICK-AUTO（§31.3 A）：盤名比對純函數測試——誤合併反例（CP1-4／CP5、厚A／厚B、
// 城巴各車廠、Weave OL／Robinson）永遠唔自動合併；正例（全半形／空白／括號差異）對得上。
// 零 DB 依賴，全部合成盤名。
import { describe, it, expect } from "vitest";
import { classifySiteName, distinguishingTokens, jaroWinkler, levenshtein, normalizeSiteKey, stripSiteSuffix, sameTokens, SITE_AUTO_MIN, type SiteNameCandidate } from "@/lib/month-close/auto/site-match";
import { externalBrokerForRow, matchExternalAlias } from "@/lib/roster-upload/external-alias";

function sites(...defs: Array<[string, string, string[]?]>): SiteNameCandidate[] {
  return defs.map(([id, canonicalName, aliases]) => ({ id, canonicalName, aliases: aliases ?? [] }));
}

describe("盤名正規化／分辨字／相似度", () => {
  it("正規化：NFKC、去空白／標點／括號符號，內容保留", () => {
    expect(normalizeSiteKey("數碼港 CP5 （IC）")).toBe("數碼港cp5ic");
    expect(normalizeSiteKey("ＣＰ５")).toBe("cp5");
    expect(stripSiteSuffix(normalizeSiteKey("卓弘物業服務有限公司"))).toBe("卓弘");
    // 剝完淨係得 1 個字就唔剝
    expect(stripSiteSuffix("管理")).toBe("管理");
  });

  it("分辨字：英文字母段、數字段、中文數字、方位字", () => {
    expect(distinguishingTokens("數碼港 CP1-4")).toEqual(["1", "4", "cp"]);
    expect(distinguishingTokens("厚A")).toEqual(["a"]);
    expect(sameTokens("CP1-4", "CP5")).toBe(false);
    expect(sameTokens("厚A", "厚B")).toBe(false);
    expect(sameTokens("第一期", "第二期")).toBe(false);
    expect(sameTokens("東廠", "西廠")).toBe(false);
    expect(sameTokens("數碼港 CP5", "數碼港CP5")).toBe(true);
  });

  it("編輯距離／Jaro-Winkler 基本性質", () => {
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("", "ab")).toBe(2);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("柴灣城巴車廠", "上環城巴車廠")).toBeLessThan(SITE_AUTO_MIN);
  });
});

describe("classifySiteName：誤合併反例（永遠唔自動合併）", () => {
  it("CP1-4 vs CP5 → new（唔係 propose 都唔係 auto）", () => {
    const r = classifySiteName("數碼港 CP1-4", sites(["s1", "數碼港 CP5"]));
    expect(r.level).toBe("new");
    expect(r.siteId).toBeNull();
    expect(r.lookalikeSiteIds).toContain("s1");
  });
  it("CP5 vs CP1-4（反向）→ new", () => {
    expect(classifySiteName("數碼港 CP5", sites(["s1", "數碼港 CP1-4"])).level).toBe("new");
  });
  it("厚A vs 厚B（TKO 厚A/B/C）→ new", () => {
    const cand = sites(["a", "TKO Gateway 厚A"], ["b", "TKO Gateway 厚B"], ["c", "TKO Gateway 厚C"]);
    const r = classifySiteName("TKO Gateway 厚D", cand);
    expect(r.level).toBe("new");
    expect(classifySiteName("TKO Gateway 厚B", cand).siteId).toBe("b");
  });
  it("城巴各車廠：差兩個字（地名）唔自動合併", () => {
    const cand = sites(["c1", "柴灣城巴車廠"], ["c2", "屯門城巴車廠"], ["c3", "黃竹坑城巴車廠"]);
    for (const n of ["上環城巴車廠", "東涌城巴車廠", "西九龍城巴車廠"]) {
      const r = classifySiteName(n, cand);
      expect(r.level === "auto" || r.level === "exact").toBe(false);
    }
  });
  it("Weave OL／Robinson（同前綴、字母段唔同）→ new", () => {
    const cand = sites(["w1", "Weave Olympic OL"], ["w2", "Weave Mid-level ML"]);
    const r = classifySiteName("Weave Robinson RR", cand);
    expect(r.level).toBe("new");
  });
  it("Po Lam 寶A／寶B、第一期／第二期、東／西 → 唔合併", () => {
    expect(classifySiteName("寶琳 寶B", sites(["a", "寶琳 寶A"])).level).toBe("new");
    expect(classifySiteName("某苑第二期", sites(["a", "某苑第一期"])).level).toBe("new");
    expect(classifySiteName("凱和山 西", sites(["a", "凱和山 東"])).level).toBe("new");
  });
});

describe("classifySiteName：正例", () => {
  it("全形／半形、空白、括號差異 → exact", () => {
    const cand = sites(["s1", "港大職員宿舍 (上)"]);
    for (const n of ["港大職員宿舍（上）", "港大職員宿舍(上)", "港大職員宿舍 （上）", "港大職員宿舍　(上) "]) {
      const r = classifySiteName(n, cand);
      expect(r.level).toBe("exact");
      expect(r.siteId).toBe("s1");
    }
  });
  it("別名完全相同（正規化後）→ exact", () => {
    const r = classifySiteName("CP５", sites(["s1", "數碼港 CP5", ["CP5"]]));
    expect(r.level).toBe("exact");
  });
  it("常見後綴（有限公司）剝走之後相同 → exact", () => {
    const r = classifySiteName("卓弘", sites(["s1", "卓弘物業服務有限公司"]));
    expect(r.level).toBe("exact");
  });
  it("只差一個字（同字母數字）、第二候選低 ≥0.08 → auto", () => {
    const cand = sites(["s1", "南豐新邨大廈管理處測試"], ["s2", "完全唔related嘅盤"]);
    const r = classifySiteName("南豐新村大廈管理處測試", cand);
    expect(r.level).toBe("auto");
    expect(r.siteId).toBe("s1");
    expect(r.score).toBeGreaterThanOrEqual(SITE_AUTO_MIN);
  });
  it("相似但第二候選太近 → propose，唔係 auto", () => {
    const cand = sites(["s1", "南豐新邨大廈管理處測試"], ["s2", "南豐新村大廈管理處測試甲"]);
    const r = classifySiteName("南豐新邨大廈管理處測試乙", cand);
    expect(["propose", "new"]).toContain(r.level);
    expect(r.level).not.toBe("auto");
  });
  it("0.75–0.90 → propose，候選預填最高分", () => {
    const r = classifySiteName("海景花園大廈", sites(["s1", "海景花園"]));
    expect(["propose", "auto", "exact"]).toContain(r.level);
  });
  it("完全無關 → new，冇候選", () => {
    const r = classifySiteName("全新嘅獨特盤名ABC", sites(["s1", "數碼港 CP5"]));
    expect(r.level).toBe("new");
    expect(r.candidates).toEqual([]);
  });
  it("同多個盤正規化後相同 → propose（唔肯定）", () => {
    const r = classifySiteName("某盤", sites(["a", "某盤"], ["b", "某 盤"]));
    expect(r.level).toBe("propose");
    expect(r.candidates.length).toBe(2);
  });
});

describe("external 別名（rank／姓名）", () => {
  const ext = [{ id: "b10", code: "B10", name: "客戶自己人", aliases: ["Wilson Guard", "Wilson Supervisor"] }];
  it("rank／姓名命中別名（大細楷／後綴無所謂）", () => {
    expect(matchExternalAlias("Wilson Guard", ext)?.id).toBe("b10");
    expect(matchExternalAlias("wilson  supervisor 2", ext)?.id).toBe("b10");
    expect(externalBrokerForRow({ rankRaw: "Wilson Guard", nameRaw: "任意" }, ext)?.id).toBe("b10");
    expect(externalBrokerForRow({ rankRaw: "日更保安員", nameRaw: "Wilson Supervisor" }, ext)?.id).toBe("b10");
  });
  it("唔係外人：Wilson Wong／普通 rank 唔中", () => {
    expect(matchExternalAlias("Wilson Wong", ext)).toBeNull();
    expect(externalBrokerForRow({ rankRaw: "日更保安員", nameRaw: "測試安員甲" }, ext)).toBeNull();
    expect(externalBrokerForRow({ rankRaw: "Wilson Guard" }, [])).toBeNull();
  });
});
