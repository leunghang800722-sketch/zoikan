// TR-1：scripts/staff-import/19-triage-reread.ts 核心——mapping／保守規則（fake FieldResult）＋ --dry 合成 manifest。全部合成、無 PII、唔打 API。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addOutcome, buildStaffNoIndex, docIdsForPerson, emptySummary, needsReread, pickDocPages, proposeFromPicks, summaryLines, OCR_PIPELINE_VERSION, refsHashOf, type DocCache, type DocPage, type ExtractRow, type PkgPerson } from "../scripts/staff-import/lib/triage-reread-core";
import { fileDocCache, parseArgs, resolveSourcePage, run, main } from "../scripts/staff-import/19-triage-reread";
import { ArgError } from "../scripts/staff-import/lib/eval-ocr-core";
import { proposalsBodySchema } from "@/lib/triage/proposals";

const NOW = new Date("2026-10-16T00:00:00Z");
const lf = (value: string | null, status: "confirmed" | "review" | "missing") => ({ value, status });
const person = (over: Partial<PkgPerson> = {}): PkgPerson => ({
  key: "pk-1",
  hkid: lf("Z900001(2)", "review"),
  nameZh: lf("測試乙", "review"),
  nameEn: lf("TEST ALPHA", "review"),
  dateOfBirth: lf("1990-01-15", "review"),
  phone: lf("90001110", "review"),
  address: lf("舊地址", "review"),
  staffNumbers: [{ scheme: "DRY", number: "DRY1" }],
  reasons: [],
  ...over,
});
const fr = (value: string, status: "confirmed" | "review" | "missing" = "confirmed", arbiter?: "agree_a" | "agree_b") => ({ status, value, ...(arbiter ? { arbiter } : {}) });
const GOOD = {
  name_zh: { doc: "id_card" as const, result: fr("測試甲"), cross: "match" as const },
  name_en: { doc: "id_card" as const, result: fr("TEST ALPHA") },
  hkid: { doc: "id_card" as const, result: fr("Z900001(2)") },
  dob: { doc: "id_card" as const, result: fr("1990-01-15") },
  phone: { doc: "onboarding_form" as const, result: fr("9000 1111") },
  address: { doc: "address_proof" as const, result: fr("新界火炭示範街99號虛構大廈15樓A室") },
};

describe("proposeFromPicks：保守規則", () => {
  it("全部 confirmed＋valid → 6 欄建議；值用 canon；confidence 按交叉核對；match 帶身份證／工號", () => {
    const o = proposeFromPicks(person(), GOOD, NOW);
    expect(o.skipped).toEqual({});
    expect(o.proposals.map((p) => [p.field, p.value, p.basis, p.doc, p.confidence])).toEqual([
      ["nameZh", "測試甲", "two_reads", "id_card", "high"],
      ["nameEn", "TEST ALPHA", "two_reads", "id_card", "high"], // TE-11.1：身份證頁兩讀一致＝high，唔需要入職表交叉
      ["hkid", "Z9000012", "two_reads", "id_card", "high"],
      ["dateOfBirth", "1990-01-15", "two_reads", "id_card", "high"],
      ["phone", "90001111", "two_reads", "onboarding_form", "medium"],
      ["address", "新界火炭示範街99號虛構大廈15樓A室", "two_reads", "address_proof", "medium"],
    ]);
    expect(o.proposals[0]!.match).toEqual({ hkid: "Z900001(2)", staff_numbers: ["DRY1"] });
  });
  it("只對 package 為 review 嘅欄出建議；confirmed／missing 欄唔重讀", () => {
    const p = person({ nameZh: lf("測試乙", "confirmed"), hkid: lf(null, "missing") });
    const o = proposeFromPicks(p, GOOD, NOW);
    expect(o.proposals.map((x) => x.field)).toEqual(["nameEn", "dateOfBirth", "phone", "address"]);
    expect(needsReread(person({ nameZh: lf("a", "confirmed"), hkid: lf("b", "confirmed"), nameEn: lf("c", "confirmed"), dateOfBirth: lf("d", "confirmed"), phone: lf("e", "confirmed"), address: lf("f", "confirmed") }))).toBe(false);
    expect(needsReread(person({ nameZh: lf("a", "confirmed"), hkid: lf("b", "review"), nameEn: lf("c", "confirmed"), dateOfBirth: lf("d", "confirmed"), phone: lf("e", "confirmed"), address: lf("f", "confirmed") }))).toBe(true);
  });
  it("review／missing／arbiter agree_a／格式錯／來源錯／打字名單唔一致 → 唔建議並計原因；入職表交叉核對 differs 唔阻擋（TR-2）", () => {
    const picks = {
      name_zh: { doc: "id_card" as const, result: fr("測試甲", "review") },
      name_en: { doc: "id_card" as const, result: fr("TEST ALPHA", "confirmed", "agree_a") },
      hkid: { doc: "id_card" as const, result: fr("Z900001(3)") }, // check digit 錯
      dob: { doc: "id_card" as const, result: fr("1990-01-15"), cross: "differs" as const },
      phone: { doc: "address_proof" as const, result: fr("90001111") }, // 來源錯
      address: { doc: "onboarding_form" as const, result: fr("新界火炭示範街99號虛構大廈15樓A室") }, // 住址證明冇 → 入職表地址唔收
    };
    const o = proposeFromPicks(person(), picks, NOW);
    expect(o.proposals.map((x) => [x.field, x.confidence])).toEqual([["dateOfBirth", "high"]]); // TE-11.1：入職表 differs 唔降級（flag form_differs）
    expect(o.proposals[0]!.flags).toEqual(["form_differs"]);
    expect(o.skipped).toEqual({ not_confirmed: 1, arbiter_agree_a: 1, invalid_format: 1, wrong_source: 2 });
    expect(o.skippedByField).toEqual({ nameZh: { not_confirmed: 1 }, nameEn: { arbiter_agree_a: 1 }, hkid: { invalid_format: 1 }, phone: { wrong_source: 1 }, address: { wrong_source: 1 } });
    const typed = proposeFromPicks(person({ reasons: ["mismatch_nameZh", "phone_differs_from_list", "nameZh_near_match"] }), GOOD, NOW);
    expect(typed.skipped).toEqual({ typed_list_disagrees: 2 });
    expect(typed.skippedByField).toEqual({ nameZh: { typed_list_disagrees: 1 }, phone: { typed_list_disagrees: 1 } });
    expect(typed.proposals.map((x) => x.field)).toEqual(["nameEn", "hkid", "dateOfBirth", "address"]);
    expect(proposeFromPicks(person(), {}, NOW).skipped).toEqual({ no_read: 6 });
  });
  it("TR-2／TE-11.1：身份證 differs（入職表手寫唔一致）照建議，confidence 仍 high，帶 form_differs（資訊）；arbiter 介入照舊（交叉一致先 high）", () => {
    const o = proposeFromPicks(person(), { name_zh: { doc: "id_card", result: fr("測試甲"), cross: "differs" }, hkid: { doc: "id_card", result: fr("Z900001(2)"), cross: "match" } }, NOW);
    expect(o.proposals.map((x) => [x.field, x.confidence])).toEqual([["nameZh", "high"], ["hkid", "high"]]);
    expect(o.proposals.map((x) => x.flags)).toEqual([["form_differs"], undefined]);
    const arb = proposeFromPicks(person(), { name_zh: { doc: "id_card", result: fr("測試甲", "confirmed", "agree_b"), cross: "differs" }, hkid: { doc: "id_card", result: fr("Z900001(2)", "confirmed", "agree_b"), cross: "match" } }, NOW);
    expect(arb.proposals.map((x) => [x.field, x.basis, x.confidence])).toEqual([["nameZh", "arbiter", "medium"], ["hkid", "arbiter", "high"]]);
  });
  it("arbiter agree_b → basis=arbiter（照收）；日期曆法／電話 8 位／姓名格式把關", () => {
    const o = proposeFromPicks(person(), { ...GOOD, hkid: { doc: "id_card", result: fr("Z900001(2)", "confirmed", "agree_b") }, dob: { doc: "id_card", result: fr("1990-02-30") }, phone: { doc: "onboarding_form", result: fr("1234567") }, name_zh: { doc: "id_card", result: fr("TEST") } }, NOW);
    expect(o.proposals.find((x) => x.field === "hkid")!.basis).toBe("arbiter");
    expect(o.skipped).toEqual({ invalid_format: 3 });
  });
});

describe("揀頁／工號索引", () => {
  const ex = (docId: string, pages: ExtractRow["pages"], address?: { page: number }): ExtractRow => ({ docId, pages, ...(address ? { address } : {}) });
  it("身份證／住址證明（優先 extract.address.page）／入職表各 1 頁；缺就缺", () => {
    const m = new Map([
      ["d1", ex("d1", [{ page: 1, kinds: ["blank"] }, { page: 2, kinds: ["id_card"], primary: "id_card" }, { page: 3, kinds: ["address_proof"] }, { page: 4, kinds: ["address_proof"] }], { page: 4 })],
      ["d2", ex("d2", [{ page: 1, kinds: ["application_form"], primary: "application_form" }])],
    ]);
    expect(pickDocPages(["d1", "d2"], m)).toEqual([
      { type: "id_card", docId: "d1", page: 2 },
      { type: "address_proof", docId: "d1", page: 4 },
      { type: "onboarding_form", docId: "d2", page: 1 },
    ]);
    expect(pickDocPages(["d2"], m)).toEqual([{ type: "onboarding_form", docId: "d2", page: 1 }]);
    expect(pickDocPages(["zzz"], m)).toEqual([]);
  });
  it("工號（key 或 staffNos，正規化大小寫／空白）→ docIds，去重", () => {
    const idx = buildStaffNoIndex([{ key: "u 90001", docIds: ["a"] }, { key: "x", staffNos: ["U90001", "U90002"], docIds: ["b", "a"] }, { key: "none", docIds: [] }]);
    expect(docIdsForPerson(person({ staffNumbers: [{ number: "U90001" }, { number: "U90002" }] }), idx)).toEqual(["a", "b"]);
    expect(docIdsForPerson(person({ staffNumbers: [{ number: "U1" }] }), idx)).toEqual([]);
  });
});

describe("--dry 合成 manifest（fake client，無 API／無 data）", () => {
  it("run：18 人入 13 人需重讀（TE-11.2／11.3 加 7 個入職表分級個案）、2 人冇文件；46 條建議；原因計數固定；輸出符合 server proposalsBodySchema；console 摘要冇值", async () => {
    const r = await run({ package: null, personFields: null, extract: null, index: null, docsDir: "x", out: null, dry: true, limit: null, onlyKey: null, concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: true, ocrDir: null, crosscheck: null, visionBin: null }, NOW);
    expect(r.summary).toMatchObject({ persons_in_package: 18, persons_needing_reread: 13, persons_no_docs: 2, persons_processed: 11, persons_failed: 0, persons_with_proposals: 11, proposals_total: 46, form_differs: 1, form_conflict: 3, card_unverified: 1, form_unproven: 1 });
    expect(r.summary.proposals_by_field).toEqual({ nameZh: 10, nameEn: 11, dateOfBirth: 10, phone: 4, address: 11 });
    expect(r.summary.proposals_by_basis).toEqual({ two_reads: 46 });
    expect(r.summary.not_proposed_reasons).toEqual({ not_confirmed: 8, typed_list_disagrees: 1, arbiter_agree_a: 1 }); // TE-11.2 新個案嘅電話 fake 讀數唔一致（只影響 phone，唔係分級對象）
    expect(r.summary.ocr_calls).toBeGreaterThan(0);
    expect(proposalsBodySchema.safeParse({ version: 1, summary: r.summary, proposals: r.proposals }).success).toBe(true);
    const lines = summaryLines(r.summary).join("\n");
    expect(lines).not.toMatch(/測試|Z90000|9000111|火炭/);
    // --limit／--only-key
    const one = await run({ package: null, personFields: null, extract: null, index: null, docsDir: "x", out: null, dry: true, limit: 1, onlyKey: null, concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: true, ocrDir: null, crosscheck: null, visionBin: null }, NOW);
    expect(one.summary.persons_processed).toBe(1);
    const key = await run({ package: null, personFields: null, extract: null, index: null, docsDir: "x", out: null, dry: true, limit: null, onlyKey: "dry-person-3", concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: true, ocrDir: null, crosscheck: null, visionBin: null }, NOW);
    expect(key.summary).toMatchObject({ persons_processed: 1, proposals_total: 4 });
  });
  it("addOutcome／emptySummary 純計數", () => {
    const s = emptySummary(NOW);
    addOutcome(s, proposeFromPicks(person(), GOOD, NOW));
    expect(s).toMatchObject({ persons_with_proposals: 1, proposals_total: 6 });
  });
});

describe("TR-2 讀數快取", () => {
  const A = { package: null, personFields: null, extract: null, index: null, docsDir: "x", out: null, dry: true, limit: null, onlyKey: null, concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: true, ocrDir: null, crosscheck: null, visionBin: null };
  const memCache = () => {
    const m = new Map<string, unknown>();
    const stats = { gets: 0, hits: 0, sets: 0 };
    const c: DocCache = {
      async get(d) {
        stats.gets += 1;
        const v = m.get(`${d.type}|${d.docId}|${d.page}`);
        if (v) stats.hits += 1;
        return v ? (JSON.parse(JSON.stringify(v)) as never) : null;
      },
      async set(d, r) {
        stats.sets += 1;
        m.set(`${d.type}|${d.docId}|${d.page}`, JSON.parse(JSON.stringify(r)));
      },
    };
    return { c, stats };
  };
  it("第一次跑寫快取、第二次全命中（0 次 OCR 呼叫）而且結果一樣", async () => {
    const { c, stats } = memCache();
    const r1 = await run(A, NOW, c);
    expect(r1.summary.ocr_calls).toBeGreaterThan(0);
    expect(r1.summary.cache_hits).toBe(0);
    expect(stats.sets).toBeGreaterThan(0);
    const r2 = await run(A, NOW, c);
    expect(r2.summary.ocr_calls).toBe(0);
    expect(r2.summary.cache_hits).toBe(stats.sets);
    expect(r2.proposals).toEqual(r1.proposals);
    expect(r2.summary.not_proposed_reasons).toEqual(r1.summary.not_proposed_reasons);
    expect(r2.summary.skipped_by_field).toEqual(r1.summary.skipped_by_field);
  });
  it("fileDocCache：落檔／讀返／--no-cache 強制 miss／壞檔當 miss；parseArgs --cache／--no-cache；cache 路徑要喺 data/ 下", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tr2-"));
    try {
      const d: DocPage = { type: "id_card", docId: "doc/../x", page: 2 };
      const fake = { type: "id_card", fields: {}, usage: { calls: 1 } } as never;
      await fileDocCache(dir, false).set(d, fake, "none");
      expect(await fileDocCache(dir, false).get(d, "none")).toMatchObject({ type: "id_card" });
      expect(await fileDocCache(dir, true).get(d, "none")).toBeNull();
      expect(await fileDocCache(dir, false).get({ ...d, type: "address_proof" }, "none")).toBeNull();
      expect(await fileDocCache(dir, false).get({ ...d, page: 3 }, "none")).toBeNull();
      await writeFile(path.join(dir, "id_card__doc____x__p2.json"), "{oops");
      expect(await fileDocCache(dir, false).get(d, "none")).toBeNull();
      // TR-2.2：refs 指紋／docId／管線版本任一唔對＝miss
      const f = path.join(dir, "id_card__doc____x__p2.json");
      const good = { version: OCR_PIPELINE_VERSION, docId: d.docId, refsHash: "abc", result: fake };
      await writeFile(f, JSON.stringify(good));
      expect(await fileDocCache(dir, false).get(d, "abc")).toMatchObject({ type: "id_card" });
      expect(await fileDocCache(dir, false).get(d, "zzz")).toBeNull();
      await writeFile(f, JSON.stringify({ ...good, docId: "other" }));
      expect(await fileDocCache(dir, false).get(d, "abc")).toBeNull();
      await writeFile(f, JSON.stringify({ ...good, version: "old" }));
      expect(await fileDocCache(dir, false).get(d, "abc")).toBeNull();
      await writeFile(f, JSON.stringify({ ...good, version: 1 }));
      expect(await fileDocCache(dir, false).get(d, "abc")).toBeNull();
      expect(refsHashOf(null)).toBe("none");
      expect(refsHashOf({})).toBe("none");
      const r1 = { name_zh: { value: "甲" }, hkid: { value: "X" } } as never;
      const r2 = { hkid: { value: "X" }, name_zh: { value: "甲" } } as never;
      expect(refsHashOf(r1)).toBe(refsHashOf(r2));
      expect(refsHashOf(r1)).not.toBe(refsHashOf({ hkid: { value: "Y" } } as never));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(parseArgs(["--cache", "data/x/cache", "--no-cache"])).toMatchObject({ cache: "data/x/cache", noCache: true });
    await expect(main(["--dry", "--cache", "/tmp/not-under-data"])).rejects.toThrow(ArgError);
  });
});

describe("參數／路徑", () => {
  it("parseArgs：預設／錯誤；--out 必須喺 data/ 下", async () => {
    expect(parseArgs(["--dry", "--limit", "3", "--only-key", "k", "--concurrency", "9"])).toMatchObject({ dry: true, limit: 3, onlyKey: "k", concurrency: 8, docsDir: "data/2026-09/staff-docs" });
    expect(() => parseArgs(["--limit", "0"])).toThrow(ArgError);
    expect(() => parseArgs(["--zzz"])).toThrow(ArgError);
    expect(() => parseArgs(["--out"])).toThrow(ArgError);
    await expect(main(["--dry", "--out", "/tmp/not-under-data.json"])).rejects.toThrow(ArgError);
    await expect(main([])).rejects.toThrow(ArgError); // 真跑缺 --out
  });
  it("resolveSourcePage：單檔 PDF 用頁碼、單圖頁=1、資料夾多圖按頁揀、含 PDF 又多檔＝null、唔存在＝null", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tr1-"));
    try {
      await writeFile(path.join(dir, "a.pdf"), "x");
      await writeFile(path.join(dir, "b.jpg"), "x");
      await mkdir(path.join(dir, "imgs"));
      await writeFile(path.join(dir, "imgs", "2.jpg"), "x");
      await writeFile(path.join(dir, "imgs", "1.jpg"), "x");
      await mkdir(path.join(dir, "mixed"));
      await writeFile(path.join(dir, "mixed", "1.pdf"), "x");
      await writeFile(path.join(dir, "mixed", "2.jpg"), "x");
      await mkdir(path.join(dir, "onepdf"));
      await writeFile(path.join(dir, "onepdf", "1.pdf"), "x");
      expect(await resolveSourcePage(dir, "a.pdf", 3)).toEqual({ abs: path.join(dir, "a.pdf"), page: 3 });
      expect(await resolveSourcePage(dir, "b.jpg", 5)).toEqual({ abs: path.join(dir, "b.jpg"), page: 1 });
      expect(await resolveSourcePage(dir, "imgs", 2)).toEqual({ abs: path.join(dir, "imgs", "2.jpg"), page: 1 });
      expect(await resolveSourcePage(dir, "imgs", 3)).toBeNull();
      expect(await resolveSourcePage(dir, "mixed", 1)).toBeNull();
      expect(await resolveSourcePage(dir, "onepdf", 2)).toEqual({ abs: path.join(dir, "onepdf", "1.pdf"), page: 2 });
      expect(await resolveSourcePage(dir, "nope", 1)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TE-11.2 整頁身份證 vs 入職表分級（錯人卡防線）", () => {
  it("--dry：輕微差異 high＋form_differs；完全唔相似／入職表出生日期唔同 medium＋form_conflict；入職表冇名冇名單 medium＋card_unverified；有名單 high", async () => {
    const r = await run({ package: null, personFields: null, extract: null, index: null, docsDir: "x", out: null, dry: true, limit: null, onlyKey: null, concurrency: 2, cache: null, noCache: false, onlyMissingHkid: false, noEmbedded: true, ocrDir: null, crosscheck: null, visionBin: null }, NOW);
    const sig = (n: number) => [...new Set(r.proposals.filter((p) => p.person_key === `dry-person-${n}` && p.doc === "id_card").map((p) => `${p.confidence}:${(p.flags ?? []).join("+")}`))];
    expect(sig(12)).toEqual(["high:form_differs"]);
    expect(sig(13)).toEqual(["medium:form_conflict"]);
    expect(sig(14)).toEqual(["medium:form_conflict"]);
    expect(sig(15)).toEqual(["medium:card_unverified"]);
    expect(sig(16)).toEqual(["high:"]);
    expect(sig(17)).toEqual(["medium:form_differs"]); // TE-11.3：只得中文可比、差字而冇硬證據（入職表冇 hkid）→ 留人
    expect(sig(18)).toEqual(["medium:form_conflict"]); // 兄弟姊妹：中文差 1 字、英文唔同 → conflict
    expect(sig(1)).toEqual(["high:"]); // 入職表一致 → 不變
  });
  it("gradeFormAgreement／applyFormGrade 純函數", async () => {
    const { gradeFormAgreement, applyFormGrade, zhOverlap } = await import("../scripts/staff-import/lib/card-reread");
    expect(zhOverlap("測試甲", "測試")).toBeCloseTo(2 / 3, 5);
    expect(gradeFormAgreement({ nameZh: "測試甲" }, { nameZh: "測試甲" })).toBe("agree");
    expect(gradeFormAgreement({ nameZh: "測試甲" }, { nameZh: "測試" })).toBe("minor_unproven"); // 重疊 ≥0.5 但冇硬證據
    expect(gradeFormAgreement({ nameZh: "測試甲" }, { nameZh: "測試" }, true)).toBe("minor"); // 有硬證據（入職表 hkid＝卡／印刷佐證／名單）
    expect(gradeFormAgreement({ nameZh: "測試甲" }, { nameZh: "張三李" })).toBe("conflict");
    expect(gradeFormAgreement({ nameEn: "CHAN TAI MAN" }, { nameEn: "CHAN T M" })).toBe("minor"); // looseEnglishNameMatch
    expect(gradeFormAgreement({ nameEn: "CHAN TAI MAN KEI" }, { nameEn: "CHAN TAI MAN" })).toBe("minor"); // S2：入職表係卡 token 子集（漏咗中間名）
    expect(gradeFormAgreement({ nameEn: "CHAN TAI MAN" }, { nameEn: "CHAN TAI MAN KEI" })).toBe("conflict"); // 入職表多咗 token（唔係子集）
    expect(gradeFormAgreement({ nameEn: "CHAN TAI MAN" }, { nameEn: "WONG SIU MING" })).toBe("conflict");
    // TE-11.3：中英文兩邊都可比 → 兩樣都要過；任一唔過 conflict（兄弟姊妹：陳大明 vs 陳大文）
    expect(gradeFormAgreement({ nameZh: "測試甲", nameEn: "CHAN TAI MAN" }, { nameZh: "張三李", nameEn: "CHAN T M" })).toBe("conflict");
    expect(gradeFormAgreement({ nameZh: "陳大明", nameEn: "CHAN TAI MING" }, { nameZh: "陳大文", nameEn: "CHAN TAI MAN" })).toBe("conflict");
    expect(gradeFormAgreement({ nameZh: "陳大明", nameEn: "CHAN TAI MING" }, { nameZh: "陳大明", nameEn: "CHAN T M" })).toBe("minor");
    expect(gradeFormAgreement({ nameZh: "陳大明", nameEn: "CHAN TAI MING" }, { nameZh: "陳大明", nameEn: "chan  tai ming" })).toBe("agree");
    expect(gradeFormAgreement({ nameZh: "陳大明" }, { nameZh: "陳 大明" })).toBe("agree"); // 空白差異
    expect(gradeFormAgreement({ nameZh: "測試甲", dob: "1990-01-15" }, { nameZh: "測試甲", dob: "1991-02-03" })).toBe("conflict");
    expect(gradeFormAgreement({ nameZh: "測試甲" }, {})).toBe("no_form");
    expect(gradeFormAgreement({ nameZh: "測試甲" }, { nameEn: "CHAN" })).toBe("no_form"); // 冇可比語言
    const P = (f: string, over: object = {}) => ({ person_key: "k", field: f, value: "v", basis: "two_reads", doc: "id_card", confidence: "high", match: { hkid: null, staff_numbers: [] }, ...over }) as never;
    expect(applyFormGrade([P("nameZh")], "minor_unproven", false)[0]).toMatchObject({ confidence: "medium", flags: ["form_differs"] });
    expect(applyFormGrade([P("nameZh")], "no_form", true)[0]).toMatchObject({ confidence: "high" });
    expect(applyFormGrade([P("nameZh")], "no_form", false)[0]).toMatchObject({ confidence: "medium", flags: ["card_unverified"] });
    expect(applyFormGrade([P("nameZh", { flags: ["printed_corroborated"] })], "no_form", false)[0]).toMatchObject({ confidence: "high" });
    expect(applyFormGrade([P("nameZh"), P("phone", { doc: "onboarding_form" })], "conflict", false).map((p) => p.confidence)).toEqual(["medium", "high"]);
    expect(applyFormGrade([P("nameZh", { confidence: "low" })], "conflict", false)[0]).toMatchObject({ confidence: "low" });
  });
});

