// WP-STAFF-IMPORT Stage A3：Opus 抽樣驗收後嘅規則修正——全部合成資料。
import { describe, expect, it } from "vitest";
import { aggregateDoc, recipientMatches, type DocExtract } from "../scripts/staff-import/lib/aggregate";
import { locateAddressBox, locateNameBox } from "../scripts/staff-import/lib/crop-box";
import { classifyPage, extractAddress, extractIdCard, findAddressBlock, isIdAnchorLine } from "../scripts/staff-import/lib/extract";
import type { OcrLine, OcrPage } from "../scripts/staff-import/lib/ocr";
import { groupPersons } from "../scripts/staff-import/lib/persons";
import type { PhoneFinal } from "../scripts/staff-import/lib/phone";
import { resolvePerson, resolvePersonPhone, type PersonDocIn } from "../scripts/staff-import/lib/person-fields";

const L = (t: string, x: number, y: number, c = 0.9): OcrLine => ({ t, c, x, y, w: 0.1, h: 0.01 });

const idLines = (extra: OcrLine[] = []): OcrLine[] => [
  L("香港永久性居民身份證", 0.5, 0.8),
  L("HONG KONG PERMANENT IDENTITY CARD", 0.45, 0.77),
  L("測試安員", 0.45, 0.7),
  L("CHAN, Tai", 0.45, 0.67),
  L("Man", 0.6, 0.67),
  L("Kit", 0.45, 0.64),
  L("出生日期 Date of Birth", 0.55, 0.6),
  L("01-02-1980", 0.55, 0.58),
  L("男M", 0.7, 0.58),
  L("A123456（3）", 0.6, 0.5),
  ...extra,
];

describe("必修 3：地址 block 完整、截斷標記、排除非住址", () => {
  it("中間冇關鍵字嘅屋苑行都接，並且攞到地區行為止", () => {
    const lines = [
      L("TEST CHAN", 0.08, 0.9),
      L("FLAT 12, 3/F, SAMPLE HOUSE", 0.08, 0.885),
      L("DEMO GARDENVIEW", 0.08, 0.87),
      L("TSUEN WAN, NEW TERRITORIES", 0.08, 0.855),
      L("賬單日期：01/01/2026", 0.08, 0.8),
    ];
    const b = findAddressBlock(lines)!;
    expect(b.lines.map((l) => l.t)).toEqual(["FLAT 12, 3/F, SAMPLE HOUSE", "DEMO GARDENVIEW", "TSUEN WAN, NEW TERRITORIES"]);
    expect(b.truncated).toBe(false);
    expect(extractAddress(1, lines).address?.flags).toBeUndefined();
  });
  it("冇地區行 → address_truncated", () => {
    const lines = [L("TEST CHAN", 0.08, 0.9), L("FLAT 12, 3/F, SAMPLE HOUSE", 0.08, 0.885), L("DEMO ESTATE", 0.08, 0.87)];
    expect(extractAddress(1, lines).address?.flags).toEqual(["address_truncated"]);
  });
  it("表格數字、PO BOX、單價標題行唔當地址", () => {
    expect(findAddressBlock([L("UNIT PRICE", 0.1, 0.9), L("47.25", 0.1, 0.88), L("52.67", 0.1, 0.86)])).toBeNull();
    expect(findAddressBlock([L("G.P.O. BOX 132", 0.1, 0.9), L("HONG KONG", 0.1, 0.88)])).toBeNull();
  });
  it("申請表／諮詢人頁（含公司頁腳地址）唔分類做住址證明", () => {
    const lines = [L("諮詢人資料 Reference Person", 0.2, 0.95), L("FLAT 1, 2/F, OFFICE BLDG", 0.1, 0.9), L("DEMO STREET", 0.1, 0.885), L("KOWLOON", 0.1, 0.87)];
    expect(classifyPage({ page: 3, lines }).kinds).not.toContain("address_proof");
  });
  it("電訊賬單（本人收件人，含『港鐵隧道服務牌照費』明細）係住址證明", () => {
    const lines = [
      L("MR. TEST CHAN", 0.1, 0.85),
      L("香港", 0.1, 0.84),
      L("新界屯門", 0.1, 0.83),
      L("測試街樣本邨", 0.1, 0.815),
      L("樣本樓2011", 0.1, 0.8),
      L("港鐵隧道服務牌照及行政費", 0.12, 0.6),
      L("賬單", 0.5, 0.76),
    ];
    const c = classifyPage({ page: 5, lines });
    expect(c.kinds).toContain("address_proof");
    const a = extractAddress(5, lines);
    expect(a.address?.value).toContain("樣本樓2011");
    expect(a.recipient).toContain("TEST CHAN");
  });
  it("公司頁腳地址跨 ≥4 個檔重複 → 被 denyAddr 排除", () => {
    const bill = (): OcrPage => ({ page: 1, lines: [L("TEST CHAN", 0.1, 0.9), L("FLAT 9, 9/F, DEMO TOWER", 0.1, 0.885), L("KOWLOON", 0.1, 0.87), L("賬單", 0.5, 0.8)] });
    const key = "FLAT99FDEMOTOWERKOWLOON";
    const d = aggregateDoc("x", [bill()], { denyAddr: new Set([key]) });
    expect(d.address).toBeNull();
    expect(d.flags).toContain("address_company_template");
  });
  it("收件人名黐埋（冇空格）都對得上", () => {
    expect(recipientMatches("MRTAIMANCHAN", "CHAN Tai Man")).toBe(true);
    expect(recipientMatches("LEE SIU MING", "CHAN Tai Man")).toBe(false);
  });
});

describe("必修 5＋6：英文名斷行順序接返；身份證分類；唔由電話砌 hkid", () => {
  it("英文名順序接返（同行右邊→下一行），唔丟尾段", () => {
    const r = extractIdCard(3, idLines());
    expect(r.nameEn?.value).toBe("CHAN Tai Man Kit");
    expect(r.nameEn?.flags).toBeUndefined();
  });
  it("只得一段 → nameEn_single_segment 警示", () => {
    const lines = idLines().filter((l) => !["Man", "Kit"].includes(l.t));
    expect(extractIdCard(3, lines).nameEn?.flags).toEqual(["nameEn_single_segment"]);
  });
  it("性別行有男／女就認（唔使貼住日期）", () => {
    expect(extractIdCard(3, idLines()).sex?.value).toBe("M");
  });
  it("申請表『香港身份證號碼：』欄位標籤唔係身份證 anchor；卡面短標題先係", () => {
    expect(isIdAnchorLine("香港身份證號碼：")).toBe(false);
    expect(isIdAnchorLine("香港身份證：")).toBe(false);
    expect(isIdAnchorLine("香港永久性居民身份證")).toBe(true);
    const form = [L("職位申請表", 0.4, 0.9), L("香港身份證： A123456(3)", 0.1, 0.8), L("出生日期 01-02-1980", 0.1, 0.78)];
    expect(classifyPage({ page: 1, lines: form }).kinds).not.toContain("id_card");
  });
  it("標題行 OCR 唔到，但有效 hkid 行＋日期＋性別行 → 都認係身份證", () => {
    const lines = [L("測試安員", 0.3, 0.8), L("男M", 0.5, 0.74), L("01-02-1980", 0.45, 0.72), L("A123456（3）", 0.55, 0.69), L("雜", 0.1, 0.1), L("訊", 0.2, 0.1)];
    expect(classifyPage({ page: 4, lines }).kinds).toContain("id_card");
  });
  it("電話號碼唔會被首字母修補成 hkid（冇身份證 anchor／無括號）", () => {
    const lines = [L("聯絡電話", 0.1, 0.9), L("21234563", 0.3, 0.9), L("2123456（3）", 0.3, 0.8)];
    const r = extractIdCard(3, lines);
    expect(r.hkid).toBeNull();
  });
});

describe("pageCount／裁圖定位", () => {
  it("pageCount 唔計旋轉候選頁", () => {
    const d = aggregateDoc("x", [{ page: 1, lines: idLines() }, { page: 1, lines: idLines(), alt: true, rot: 90 }]);
    expect(d.pageCount).toBe(1);
  });
  it("姓名區涵蓋中文名＋英文名各段，唔包 hkid 行", () => {
    const { box, how } = locateNameBox(3, idLines());
    expect(how).toBe("name");
    expect(box.y1).toBeLessThan(0.75);
    expect(box.y0).toBeLessThan(0.64);
    expect(box.y0).toBeGreaterThan(0.55);
  });
  it("定位唔到姓名 → 成張卡；再唔到 → 成頁", () => {
    expect(locateNameBox(1, [L("雜", 0.1, 0.1)]).how).toBe("page");
  });
  it("地址裁圖含收件人名＋地址各行；冇 block 就成頁", () => {
    const lines = [L("TEST CHAN", 0.08, 0.9), L("FLAT 12, 3/F, SAMPLE HOUSE", 0.08, 0.885), L("KOWLOON", 0.08, 0.87)];
    const { box, how } = locateAddressBox(lines);
    expect(how).toBe("block");
    expect(box.y1).toBeGreaterThan(0.9);
    expect(locateAddressBox([L("無", 0.1, 0.1)]).how).toBe("page");
  });
});

const ph = (value: string | null, status: PhoneFinal["status"], listValues: string[] = []): PhoneFinal => ({ value, status, by: [], ocr: null, reason: value ? null : "unsure", listValues });

describe("必修 7：電話跨檔解析", () => {
  it("差一位數而其中一個同名單一致 → 取名單一致嗰個（confirmed）", () => {
    const r = resolvePersonPhone([ph("91234567", "confirmed", ["91234567"]), ph("91234569", "vision_only")]);
    expect(r).toMatchObject({ status: "confirmed", value: "91234567" });
  });
  it("住宅（2／3 字頭）同手提唔算衝突，取手提", () => {
    const r = resolvePersonPhone([ph("23456789", "vision_only"), ph("91234567", "confirmed", ["91234567"])]);
    expect(r).toMatchObject({ status: "confirmed", value: "91234567" });
  });
  it("真係唔同兩個手提 → review，兩個值都留", () => {
    const r = resolvePersonPhone([ph("91234567", "vision_only"), ph("61234567", "vision_only")]);
    expect(r.status).toBe("review");
    expect(r.candidates.sort()).toEqual(["61234567", "91234567"]);
  });
  it("視覺 clear 但同名單唔同 → review；冇值 → missing", () => {
    expect(resolvePersonPhone([ph("91234567", "differs", ["92345678"])]).status).toBe("review");
    expect(resolvePersonPhone([ph(null, "unresolved")]).status).toBe("missing");
  });
});

const exOf = (o: Partial<DocExtract>): DocExtract =>
  ({
    docId: "d1", pageCount: 5, pages: [], hkid: { value: "A1234563", level: "high", conf: 0.9, page: 3, evidence: "x" }, hkidValid: true,
    nameZh: { value: "測試安員", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    nameEn: { value: "CHAN Tai Man", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    dob: { value: "1980-02-01", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    sex: { value: "M", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    address: { value: "FLAT 12 3/F SAMPLE HOUSE TSUEN WAN NT", level: "high", conf: 0.5, page: 5, evidence: "x" },
    addressRecipient: "TAI MAN CHAN", phone: null, aux: { formHkid: null, permitHkid: null, formAddress: null, formNameZh: null, formNameEn: null },
    flags: [], rescuedRot: null, ...o,
  }) as DocExtract;
const docIn = (ex: DocExtract, o: Partial<PersonDocIn> = {}): PersonDocIn => ({ docId: ex.docId, ex, fileNameZh: null, phone: ph(null, "unresolved"), listZh: [], listEn: [], listTels: [], ...o });

describe("逐欄 status（姓名／地址要視覺 clear＋佐證）", () => {
  const base = (nv: object | null, av: object | null, d: PersonDocIn = docIn(exOf({}))) =>
    resolvePerson({ key: "k", docs: [d], idDocId: "d1", addressDocId: "d1", nameVision: nv as never, addrVision: av as never });
  it("nameZh：視覺 clear 且＝檔名 → confirmed；唔同 → review 兩值都留", () => {
    const ok = base({ docId: "d1", zh: "測試安員", en: "CHAN, TAI MAN", legible: "clear" }, null, docIn(exOf({}), { fileNameZh: "測試安員" }));
    expect(ok.nameZh).toMatchObject({ status: "confirmed", value: "測試安員" });
    expect(ok.nameEn.status).toBe("confirmed");
    const bad = base({ docId: "d1", zh: "測試安負", en: null, legible: "clear" }, null, docIn(exOf({}), { fileNameZh: "測試安員" }));
    expect(bad.nameZh.status).toBe("review");
    expect(bad.nameZh.candidates).toContain("測試安員");
  });
  it("nameZh 有 near-match → 唔准 confirmed", () => {
    const d = docIn(exOf({}), { fileNameZh: "測試安貝" });
    const r = base({ docId: "d1", zh: "測試安員", en: null, legible: "clear" }, null, d);
    expect(r.nameZh.status).toBe("review");
    expect(r.nameZh.reasons).toContain("nameZh_near_match");
  });
  it("同人多檔中文名唔同 → review（唔准低信心蓋過高信心）", () => {
    const d1 = docIn(exOf({}), { fileNameZh: "測試安員" });
    const d2 = docIn(exOf({ docId: "d2", nameZh: { value: "測試安貝", level: "low", conf: 0.3, page: 3, evidence: "x" } }));
    const r = resolvePerson({ key: "k", docs: [d1, d2], idDocId: "d1", addressDocId: "d1", nameVision: { docId: "d1", zh: "測試安員", en: null, legible: "clear" }, addrVision: null });
    expect(r.nameZh.status).toBe("review");
    expect(r.nameZh.reasons).toContain("nameZh_differs_between_files");
  });
  it("nameEn：視覺＝本機接返嘅值先 confirmed；本機少尾段 → review", () => {
    const miss = docIn(exOf({ nameEn: { value: "CHAN Tai", level: "medium", conf: 0.5, page: 3, evidence: "x" } }));
    const r = base({ docId: "d1", zh: null, en: "CHAN, TAI MAN", legible: "clear" }, null, miss);
    expect(r.nameEn.status).toBe("review");
    expect(r.nameEn.value).toBe("CHAN, TAI MAN");
  });
  it("地址：視覺 clear＋收件人對得上＋同本機一致 → confirmed；收件人對唔上 → review", () => {
    const av = { docId: "d1", page: 5, recipient: "TAI MAN CHAN", address: "FLAT 12, 3/F, SAMPLE HOUSE, TSUEN WAN, NT", legible: "clear", complete: true };
    const r = base(null, av);
    expect(r.address.status).toBe("confirmed");
    const bad = base(null, { ...av, recipient: "LEE SIU MING" });
    expect(bad.address.status).toBe("review");
    expect(bad.address.reasons).toContain("address_recipient_not_matched");
    const trunc = base(null, { ...av, address: "FLAT 12, 3/F, SAMPLE HOUSE", complete: false });
    expect(trunc.address.status).toBe("review");
  });
  it("冇住址證明 → missing（自行聲明頁照舊 unresolved）", () => {
    const r = base(null, null, docIn(exOf({ address: null, flags: ["address_declaration_only"] })));
    expect(r.address).toMatchObject({ status: "missing" });
    expect(r.address.reasons).toContain("address_unresolved_declaration");
  });
  it("hkid repaired／corrected／衝突 → review；乾淨 → confirmed", () => {
    expect(base(null, null).hkid.status).toBe("confirmed");
    const rep = docIn(exOf({ hkid: { value: "A1234563", level: "low", conf: 0.5, page: 3, evidence: "x", note: "repaired" } }));
    expect(base(null, null, rep).hkid.status).toBe("review");
  });
  it("groupPersons：同 hkid 合併，冇 hkid 各自獨立", () => {
    const a = exOf({});
    const b = exOf({ docId: "d2" });
    const c = exOf({ docId: "d3", hkid: null, hkidValid: false });
    const g = groupPersons([a, b, c], () => "review");
    expect(g).toHaveLength(2);
    expect(g[0].docIds.sort()).toEqual(["d1", "d2"]);
    expect(g[1].idDocId).toBeNull();
  });
});

import { mergeGroup, type MergeDoc } from "../scripts/staff-import/lib/merge";

describe("必修 2：多檔合併唔准靜靜蓋值", () => {
  const md = (o: Partial<MergeDoc["id"]>, id = "a"): MergeDoc => ({
    docId: id, staffNo: null, grade: "review", hkidConf: 0.5,
    id: { hkid: "A1234563", nameZh: "測試安員", nameEn: "CHAN Tai Man", dob: null, sex: null, ...o }, address: null, phone: null,
  });
  it("中文名唔同 → nameZh_differs_between_files", () => {
    expect(mergeGroup([md({}), md({ nameZh: "測試安貝" }, "b")]).reasons).toContain("nameZh_differs_between_files");
  });
  it("英文名段數唔同 → 標 differs，取較長嗰個", () => {
    const m = mergeGroup([md({ nameEn: "CHAN Tai" }), md({ nameEn: "CHAN Tai Man" }, "b")]);
    expect(m.reasons).toContain("nameEn_differs_between_files");
    expect(m.nameEn).toBe("CHAN Tai Man");
  });
  it("完全一致 → 冇衝突", () => {
    expect(mergeGroup([md({}), md({}, "b")]).reasons).toEqual([]);
  });
});

import { ageOk, resolveDob, resolveSex, nameEnMissingReason } from "../scripts/staff-import/lib/person-fields";
import { locateDobBox, locateWideBox } from "../scripts/staff-import/lib/crop-box";

describe("Stage A4：dob／sex 兩獨立讀數互證", () => {
  const v = (dob: string | null, sex: string | null, legible: "clear" | "unsure" = "clear") => ({ docId: "d1", dob, sex, legible });
  it("本機 OCR＝視覺 clear → confirmed", () => {
    expect(resolveDob("1980-02-01", ["1980-02-01"], [], v("1980-02-01", "M"), "2026-10-03").status).toBe("confirmed");
  });
  it("兩讀數唔同（年份尾數）→ review，兩值都留", () => {
    const r = resolveDob("1980-02-01", ["1980-02-01"], [], v("1989-02-01", "M"), "2026-10-03");
    expect(r.status).toBe("review");
    expect(r.value).toBe("1989-02-01");
    expect(r.candidates).toContain("1980-02-01");
    expect(r.reasons).toContain("dob_vision_differs_from_ocr");
  });
  it("冇視覺讀數／unsure → review；唔會單靠 OCR confirmed", () => {
    expect(resolveDob("1980-02-01", ["1980-02-01"], [], null, "2026-10-03").status).toBe("review");
    expect(resolveDob("1980-02-01", ["1980-02-01"], [], v(null, null, "unsure"), "2026-10-03").status).toBe("review");
  });
  it("同名單生日唔同、年齡不合理、多檔唔同 → review", () => {
    expect(resolveDob("1980-02-01", ["1980-02-01"], ["1980-02-02"], v("1980-02-01", "M"), "2026-10-03").reasons).toContain("dob_differs_from_list");
    expect(resolveDob("2015-02-01", ["2015-02-01"], [], v("2015-02-01", "M"), "2026-10-03").reasons).toContain("dob_implausible");
    expect(resolveDob("1980-02-01", ["1980-02-01", "1980-02-03"], [], v("1980-02-01", "M"), "2026-10-03").reasons).toContain("dob_differs_between_files");
  });
  it("ageOk：合法日期、18–80", () => {
    expect(ageOk("1980-02-01", "2026-10-03")).toBe(true);
    expect(ageOk("1980-02-30", "2026-10-03")).toBe(false);
    expect(ageOk("2010-01-01", "2026-10-03")).toBe(false);
    expect(ageOk("1940-01-01", "2026-10-03")).toBe(false);
  });
  it("sex：視覺＝OCR → confirmed；唔同或冇視覺 → review", () => {
    expect(resolveSex("M", ["M"], v("1980-02-01", "M")).status).toBe("confirmed");
    expect(resolveSex("M", ["M"], v("1980-02-01", "F")).status).toBe("review");
    expect(resolveSex("M", ["M"], null).status).toBe("review");
  });
  it("卡面差（hkid review）→ dob／sex 即使兩讀數一致都要再加名單佐證", () => {
    const d: PersonDocIn = { docId: "d1", ex: exOf({ hkid: { value: "A1234563", level: "low", conf: 0.3, page: 3, evidence: "x", note: "repaired" } }), fileNameZh: null, phone: ph(null, "unresolved"), listZh: [], listEn: [], listTels: [], listDob: [] };
    const dv = { docId: "d1", dob: "1980-02-01", sex: "M", legible: "clear" as const };
    const weak = resolvePerson({ key: "k", docs: [d], idDocId: "d1", addressDocId: null, nameVision: null, addrVision: null, dobVision: dv });
    expect(weak.dob.status).toBe("review");
    expect(weak.dob.reasons).toContain("card_weak_needs_extra_corroboration");
    expect(weak.sex.status).toBe("review");
    const withList = resolvePerson({ key: "k", docs: [{ ...d, listDob: ["1980-02-01"] }], idDocId: "d1", addressDocId: null, nameVision: null, addrVision: null, dobVision: dv });
    expect(withList.dob.status).toBe("confirmed");
  });
  it("nameEn missing 一定有原因碼", () => {
    const d = docIn(exOf({ hkid: null, hkidValid: false }));
    expect(nameEnMissingReason({ key: "k", docs: [d], idDocId: null, addressDocId: null, nameVision: null, addrVision: null }, d, null)).toBe("nameEn_missing_no_id_page");
    const d2 = docIn(exOf({}));
    expect(nameEnMissingReason({ key: "k", docs: [d2], idDocId: "d1", addressDocId: null, nameVision: null, addrVision: null }, d2, { docId: "d1", zh: null, en: null, legible: "unsure" })).toBe("nameEn_missing_crop_unreadable");
  });
  it("出生日期裁圖：涵蓋標籤＋日期＋性別行，唔含 hkid 行", () => {
    const lines = [L("香港永久性居民身份證", 0.5, 0.8), L("測試安員", 0.45, 0.7), L("CHAN, Tai Man", 0.45, 0.67), L("出生日期 Date of Birth", 0.55, 0.6), L("01-02-1980 男M", 0.55, 0.58), L("A123456（3）", 0.6, 0.45)];
    const { box, how } = locateDobBox(3, lines);
    expect(how).toBe("dob");
    expect(box.y0).toBeGreaterThan(0.5);
    expect(box.y1).toBeLessThan(0.65);
    expect(locateDobBox(1, [L("雜", 0.1, 0.1)]).how).toBe("page_lower");
    expect(locateWideBox(1, [L("雜", 0.1, 0.1)]).how).toBe("page");
  });
});

describe("Stage A4：寄俾本人嘅非『住址證明』頁補漏", () => {
  const nameLines = (): OcrLine[] => [L("香港永久性居民身份證", 0.5, 0.8), L("HONG KONG PERMANENT IDENTITY CARD", 0.45, 0.77), L("測試安員", 0.45, 0.7), L("CHAN, Tai Man", 0.45, 0.67), L("出生日期 Date of Birth", 0.55, 0.6), L("01-02-1980 男M", 0.55, 0.58), L("A123456（3）", 0.6, 0.5)];
  const mail = (name: string, extra: string[] = []): OcrPage => ({
    page: 5,
    lines: [L("香港警務處 牌照課", 0.5, 0.95), L(name, 0.08, 0.9), L("FLAT 12, 3/F, SAMPLE HOUSE", 0.08, 0.885), L("DEMO ESTATE", 0.08, 0.87), L("KOWLOON", 0.08, 0.855), ...extra.map((t, i) => L(t, 0.5, 0.7 - i * 0.02))],
  });
  it("收件人對得上身份證姓名 → 納入候選（note=mailed_candidate）", () => {
    const d = aggregateDoc("x", [{ page: 3, lines: nameLines() }, mail("TAI MAN CHAN")]);
    expect(d.address?.flags).toContain("mailed_candidate");
  });
  it("收件人對唔上、信箱地址、僱主稅表、法定聲明 → 唔納入", () => {
    expect(aggregateDoc("x", [{ page: 3, lines: nameLines() }, mail("LEE SIU MING")]).address).toBeNull();
    expect(aggregateDoc("x", [{ page: 3, lines: nameLines() }, mail("TAI MAN CHAN", ["IR56 僱員薪酬及退休金"])]).address).toBeNull();
    expect(aggregateDoc("x", [{ page: 3, lines: nameLines() }, mail("TAI MAN CHAN", ["法定聲明"])]).address).toBeNull();
    const po: OcrPage = { page: 5, lines: [L("TAI MAN CHAN", 0.08, 0.9), L("MAIL BOX 13 SAMPLE TSUEN", 0.08, 0.885), L("P.O. BOX 12 TAI PO NT", 0.08, 0.87)] };
    expect(aggregateDoc("x", [{ page: 3, lines: nameLines() }, po]).address).toBeNull();
  });
});
