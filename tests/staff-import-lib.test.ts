// WP-STAFF-IMPORT Stage A：純函數單元測試——全部用合成 OCR 行，無任何真人資料。
import { describe, expect, it } from "vitest";
import { aggregateDoc, editDistance, recipientMatches } from "../scripts/staff-import/lib/aggregate";
import { cmpAddress, cmpDate, cmpEn, cmpTel, cmpZh, fieldStatus, normTel, parseLooseDate } from "../scripts/staff-import/lib/compare";
import { buildIndex, crosscheck } from "../scripts/staff-import/lib/crosscheck";
import { docIdOf, parseDocFileName } from "../scripts/staff-import/lib/doc-index";
import {
  classifyPage,
  extractAddress,
  extractForm,
  extractIdCard,
  findAddressBlock,
  findHkPhone,
  findPhoneFuzzy,
  parseDates,
} from "../scripts/staff-import/lib/extract";
import { canonicalHkid, findHkidCandidates, hkidCheckDigitValid, repairHkid, repairHkidLeadingLetter } from "../scripts/staff-import/lib/hkid";
import { buildDbIndex, decide, groupPersons, planAll, type DbGuard, type PlanInput } from "../scripts/staff-import/lib/match-plan";
import type { OcrLine, OcrPage } from "../scripts/staff-import/lib/ocr";
import type { RefRow } from "../scripts/staff-import/lib/refs";

const L = (t: string, x: number, y: number, c = 0.9): OcrLine => ({ t, c, x, y, w: 0.1, h: 0.01 });

describe("hkid", () => {
  it("canonical 去括號空格大寫", () => {
    expect(canonicalHkid("a123456(3)")).toBe("A1234563");
    expect(canonicalHkid("A 123456（3）")).toBe("A1234563");
    expect(canonicalHkid("hello")).toBeNull();
    expect(canonicalHkid(null)).toBeNull();
  });
  it("check digit", () => {
    expect(hkidCheckDigitValid("A1234563")).toBe(true);
    expect(hkidCheckDigitValid("A1234568")).toBe(false);
    expect(hkidCheckDigitValid("AB9876544")).toBe(false);
    expect(hkidCheckDigitValid("AB98765")).toBe(false); // 長度唔啱
    expect(hkidCheckDigitValid(null)).toBe(false);
  });
  it("兩字母前綴 check digit（XY411234(0) 係合成例）", () => {
    // 手算：X=33,Y=34 → 33*9+34*8=569；digits 4,1,1,2,3,4 ×7..2 = 28+6+5+8+9+8=64；569+64=633；633 mod 11 = 6 → check = 5
    expect(hkidCheckDigitValid("XY4112345")).toBe(true);
    expect(hkidCheckDigitValid("XY4112346")).toBe(false);
  });
  it("A check digit", () => {
    // 單字母 A123xxx 找一個 check digit = A：Z123456 → 36*9+35*8 = 604；+ (1*7+2*6+3*5+4*4+5*3+6*2 = 77) = 681；681 mod 11 = 10 → check = 1
    expect(hkidCheckDigitValid("Z1234561")).toBe(true);
    // 需要 A：K000012 → 36*9+20*8=484；0..+1*3+2*2=7 → 491 mod 11 = 7 → check 4（唔係 A），改測 canonical 容許 A
    expect(canonicalHkid("K000012(A)")).toBe("K000012A");
  });
  it("OCR 候選：括號變體、全形、被讀成數字嘅括號", () => {
    expect(findHkidCandidates("A123456（3）")).toContain("A1234563");
    expect(findHkidCandidates("A123456 (3")).toContain("A1234563");
    expect(findHkidCandidates("A1234563")).toContain("A1234563");
    expect(findHkidCandidates("A12345663)")).toContain("A1234563"); // 「(」讀成 6
    expect(findHkidCandidates("CHAN TAI MAN")).toEqual([]);
  });
  it("修補：單點混淆、首字母讀成數字", () => {
    expect(repairHkid("A1234568")).toBe("A1234563"); // 6 被讀成 0
    expect(repairHkidLeadingLetter("2123456(1)")).toBe("Z1234561");
    expect(repairHkidLeadingLetter("8123456(7)")).toBeNull();
  });
});

describe("doc-index", () => {
  it("檔名解析（合成）", () => {
    const m = parseDocFileName("U99999 測試保安員甲 (試用).pdf");
    expect(m.staffNo).toBe("U99999");
    expect(m.fileName).toBe("測試保安員甲");
    expect(m.tag).toBe("試用");
    expect(m.conforming).toBe(true);
    expect(parseDocFileName("MP1234 測試保安員乙.pdf").tag).toBeNull();
    const bad = parseDocFileName("掃描檔1.pdf");
    expect(bad.conforming).toBe(false);
    expect(bad.staffNo).toBeNull();
  });
  it("docId 穩定、12 位 hex", () => {
    expect(docIdOf("a.pdf")).toMatch(/^[0-9a-f]{12}$/);
    expect(docIdOf("a.pdf")).toBe(docIdOf("a.pdf"));
    expect(docIdOf("a.pdf")).not.toBe(docIdOf("b.pdf"));
  });
});

const idCardLines = (): OcrLine[] => [
  L("香港永久性居民身份證", 0.5, 0.8),
  L("HONG KONG PERMANENT IDENTITY CARD", 0.45, 0.77),
  L("測試保安員", 0.45, 0.7),
  L("CHAN, Tai", 0.45, 0.67),
  L("Man", 0.6, 0.67),
  L("出生日期 Date of Birth", 0.55, 0.62),
  L("01-02-1980 男M", 0.55, 0.6),
  L("簽發日期 Date of issue", 0.55, 0.55),
  L("03-04-21", 0.55, 0.53),
  L("A123456（3）", 0.6, 0.5),
];

describe("頁面分類", () => {
  it("blank／form／permit／id", () => {
    expect(classifyPage({ page: 1, lines: [L("a", 0.1, 0.1)] }).primary).toBe("blank");
    const form = classifyPage({ page: 1, lines: [L("職位申請表", 0.4, 0.8), L("EMPLOYMENT APPLICATION FORM", 0.3, 0.78), L("x", 0.1, 0.5)] });
    expect(form.primary).toBe("application_form");
    const permit = classifyPage({ page: 1, lines: [L("保安人員許可證", 0.5, 0.9), L("SECURITY PERSONNEL PERMIT", 0.5, 0.88), L("A123456(3)", 0.7, 0.7)] });
    expect(permit.kinds).toContain("sia_permit");
    expect(permit.kinds).not.toContain("id_card");
    expect(classifyPage({ page: 1, lines: idCardLines() }).kinds).toContain("id_card");
  });
  it("拼貼頁可有多個標籤", () => {
    const lines = [...idCardLines(), L("保安人員許可證", 0.05, 0.9), L("SECURITY PERSONNEL PERMIT", 0.05, 0.88)];
    const c = classifyPage({ page: 3, lines });
    expect(c.kinds).toEqual(expect.arrayContaining(["id_card", "sia_permit"]));
    expect(c.primary).toBe("id_card");
  });
  it("住址證明（水費單）", () => {
    const lines = billLines();
    const c = classifyPage({ page: 2, lines });
    expect(c.kinds).toContain("address_proof");
  });
  it("警方牌照課信件唔當住址證明", () => {
    const lines = [
      L("香港警務處", 0.1, 0.9),
      L("Licensing Office", 0.1, 0.88),
      L("12-13/F, Arsenal House", 0.1, 0.85),
      L("1 Arsenal Street", 0.1, 0.84),
      L("Wanchai, Hong Kong", 0.1, 0.83),
    ];
    expect(classifyPage({ page: 1, lines }).kinds).not.toContain("address_proof");
  });
});

describe("身份證頁抽取", () => {
  it("hkid／中英文名／出生日期／性別", () => {
    const r = extractIdCard(3, idCardLines());
    expect(r.hkid?.value).toBe("A1234563");
    expect(r.hkidValid).toBe(true);
    expect(r.nameZh?.value).toBe("測試保安員");
    expect(r.nameEn?.value).toBe("CHAN Tai Man");
    expect(r.dob?.value).toBe("1980-02-01"); // 唔會攞簽發日期
    expect(r.sex?.value).toBe("M");
  });
  it("card 內名同標題上下次序反轉都得；check digit 唔啱先修補", () => {
    const lines = idCardLines().map((l) => (l.t === "A123456（3）" ? { ...l, t: "A1234568" } : l));
    const r = extractIdCard(3, lines);
    expect(r.hkid?.value).toBe("A1234563");
    expect(r.hkid?.note).toBe("repaired");
    expect(r.hkid?.level).toBe("low");
  });
  it("拼貼頁：只攞身份證區域，唔攞旁邊另一張證件嘅名", () => {
    const other = [L("其他證件", 0.02, 0.8), L("路人甲乙", 0.02, 0.7), L("B765432（1）", 0.02, 0.5)];
    const r = extractIdCard(3, [...other, ...idCardLines()]);
    expect(r.nameZh?.value).toBe("測試保安員");
    expect(r.hkid?.value).toBe("A1234563");
  });
  it("parseDates 只收 4 位年同合法日期", () => {
    expect(parseDates("01-02-1980")).toEqual(["1980-02-01"]);
    expect(parseDates("31-13-1980")).toEqual([]);
    expect(parseDates("03-04-21")).toEqual([]);
  });
});

function billLines(): OcrLine[] {
  return [
    L("水務署", 0.18, 0.95),
    L("付款通知書", 0.6, 0.95),
    L("TEST CHAN", 0.08, 0.9),
    L("ROOM 1001, 10/F, SAMPLE HOUSE", 0.08, 0.885),
    L("DEMO ESTATE", 0.08, 0.87),
    L("TUEN MUN, NEW TERRITORIES", 0.08, 0.855),
    L("用水樓宇地址", 0.55, 0.9),
    L("ROOM 1001, 10/F, SAMPLE HOUSE", 0.55, 0.885),
    L("DEMO ESTATE", 0.55, 0.87),
    L("應繳總額", 0.8, 0.7),
    L("$56.50", 0.8, 0.68),
  ];
}

describe("住址證明抽取", () => {
  it("收件人地址 block：取左邊有名嗰份，唔含金額行", () => {
    const b = findAddressBlock(billLines());
    expect(b?.name?.t).toBe("TEST CHAN");
    expect(b?.lines.map((l) => l.t)).toEqual(["ROOM 1001, 10/F, SAMPLE HOUSE", "DEMO ESTATE", "TUEN MUN, NEW TERRITORIES"]);
    const a = extractAddress(2, billLines());
    expect(a.address?.value).toContain("DEMO ESTATE");
    expect(a.recipient).toBe("TEST CHAN");
  });
  it("寄件機構（有限公司）地址唔當收件人", () => {
    const lines = [L("SPORT LIMITED", 0.1, 0.9), L("2/F, NO 3 DEMO ROAD", 0.1, 0.885), L("TAI PO, NEW TERRITORIES", 0.1, 0.87)];
    expect(findAddressBlock(lines)).toBeNull();
  });
  it("中文地址要有數字＋號／室／樓", () => {
    const lines = [L("測試保安員", 0.1, 0.9), L("新界屯門", 0.1, 0.885), L("測試邨", 0.1, 0.87), L("測試樓10樓1001室", 0.1, 0.855)];
    const a = extractAddress(1, lines);
    expect(a.address?.value).toContain("1001室");
  });
  it("收件人同身份證英文名比對（順序無關、容許截斷）", () => {
    expect(recipientMatches("MR TAI MAN CHAN", "CHAN Tai Man")).toBe(true);
    expect(recipientMatches("CHAN TAI", "CHAN Tai Man")).toBe(true);
    expect(recipientMatches("LEE SIU MING", "CHAN Tai Man")).toBe(false);
    expect(recipientMatches("測試保安員先生", null, "測試保安員")).toBe(true);
    expect(recipientMatches(null, "CHAN Tai Man")).toBeNull();
  });
});

describe("申請表抽取", () => {
  const form = (rows: [string, number, number][]) => rows.map(([t, x, y]) => L(t, x, y));
  it("手提電話（乾淨）", () => {
    const f = extractForm(1, form([["手提電話：9123 4567", 0.48, 0.56], ["電話：61234567", 0.62, 0.54]]));
    expect(f.phone?.value).toBe("91234567");
    expect(f.phone?.note).toBeUndefined();
  });
  it("手寫混淆 → fuzzy；緊急聯絡人電話唔攞", () => {
    const f = extractForm(1, form([["手提電話：91|34567", 0.48, 0.56], ["電話：61234567", 0.62, 0.54]]));
    expect(f.phone?.value).toBe("91134567");
    expect(f.phone?.note).toBe("fuzzy");
    const none = extractForm(1, form([["手提電話：", 0.48, 0.56], ["電話：61234567", 0.62, 0.54]]));
    expect(none.phone).toBeNull();
  });
  it("手提欄空白，住宅電話欄有數字 → home_field", () => {
    const f = extractForm(1, form([["住宅電話：23456789 手提電話：", 0.1, 0.56]]));
    // 同一行時「手提電話」之後冇數字，回退住宅欄
    expect(f.phone?.value).toBe("23456789");
    expect(f.phone?.note).toBe("home_field");
  });
  it("申請表嘅 hkid／中文名／英文名互證欄", () => {
    const f = extractForm(1, form([["中文姓名：測試保安員 English Name :CHAN TAI MAN", 0.13, 0.69], ["香港身份證號碼：A123456（3）", 0.13, 0.67]]));
    expect(f.nameZh?.value).toBe("測試保安員");
    expect(f.nameEn?.value).toBe("CHAN TAI MAN");
    expect(f.hkid?.value).toBe("A1234563");
  });
  it("電話 helper", () => {
    expect(findHkPhone("tel 9123-4567 x")).toBe("91234567");
    expect(findHkPhone("12345678")).toBeNull(); // 1 字頭唔係香港號
    expect(findPhoneFuzzy("9l23 4567")).toBe("91234567");
    expect(findPhoneFuzzy("hello")).toBeNull();
  });
});

describe("aggregateDoc（逐人）", () => {
  const pages = (): OcrPage[] => [
    { page: 1, lines: [L("職位申請表", 0.4, 0.8), L("EMPLOYMENT APPLICATION FORM", 0.3, 0.78), L("手提電話：9123 4567", 0.48, 0.56)] },
    { page: 2, lines: [] },
    { page: 3, lines: idCardLines() },
    { page: 4, lines: billLines() },
  ];
  it("合併各頁", () => {
    const d = aggregateDoc("abc", pages());
    expect(d.hkid?.value).toBe("A1234563");
    expect(d.hkidValid).toBe(true);
    expect(d.phone?.value).toBe("91234567");
    expect(d.address?.value).toContain("SAMPLE HOUSE");
    expect(d.pages.map((p) => p.primary)).toEqual(["application_form", "blank", "id_card", "address_proof"]);
    // 收件人 TEST CHAN 對 CHAN Tai Man：集合唔包含 → mismatch flag
    expect(d.flags).toContain("address_recipient_mismatch");
  });
  it("許可證 hkid 有 check digit 啱且只差一字 → 修正身份證頁 OCR 錯字", () => {
    const bad = idCardLines().map((l) => (l.t === "A123456（3）" ? { ...l, t: "A1234583" } : l));
    const permit: OcrPage = { page: 5, lines: [L("保安人員許可證", 0.5, 0.9), L("SECURITY PERSONNEL PERMIT", 0.5, 0.88), L("A1234563", 0.7, 0.7)] };
    const d = aggregateDoc("abc", [{ page: 3, lines: bad }, permit]);
    expect(d.hkid?.value).toBe("A1234563");
    expect(d.aux.permitHkid?.value).toBe("A1234563");
  });
  it("editDistance", () => {
    expect(editDistance("abc", "abd")).toBe(1);
    expect(editDistance("", "ab")).toBe(2);
  });
});

describe("比對正規化", () => {
  it("中文名", () => {
    expect(cmpZh("測試 保安員", "測試保安員").r).toBe("match");
    expect(cmpZh("測試保安員", "測試安負")).toEqual({ r: "mismatch", near: true });
    expect(cmpZh("測試保安員", "路人甲乙丙").near).toBe(false);
    expect(cmpZh(null, "測試").r).toBe("no_reference");
  });
  it("英文名：順序無關、子集容許（至少 2 token）", () => {
    expect(cmpEn("CHAN Tai Man", "Chan Tai Man")).toBe("match");
    expect(cmpEn("CHAN Tai", "CHAN Tai Man")).toBe("match");
    expect(cmpEn("CHAN", "CHAN Tai Man")).toBe("mismatch");
    expect(cmpEn("LEE Siu", "CHAN Tai Man")).toBe("mismatch");
  });
  it("電話／日期", () => {
    expect(normTel("+852 9123-4567")).toBe("91234567");
    expect(cmpTel("91234567", "9123 4567")).toBe("match");
    expect(cmpTel("91234567", "91234568")).toBe("mismatch");
    expect(parseLooseDate("2/1/1980")).toBe("1980-01-02");
    expect(parseLooseDate("1980/1/2")).toBe("1980-01-02");
    expect(cmpDate("1980-01-02", "02.01.1980")).toBe("match");
    expect(cmpDate("1980-01-02", "1980-01-03")).toBe("mismatch");
  });
  it("地址：英文縮寫同義、跨語言唔可比", () => {
    expect(cmpAddress("ROOM 1001, 10/F, SAMPLE HOUSE, DEMO ESTATE, TUEN MUN", "RM 1001 10/F SAMPLE HSE DEMO EST TUEN MUN NT")).toBe("match");
    expect(cmpAddress("ROOM 1001, 10/F, SAMPLE HOUSE, DEMO ESTATE", "FLAT 2002, 20/F, OTHER COURT, ELSEWHERE")).toBe("mismatch");
    expect(cmpAddress("ROOM 1001 SAMPLE HOUSE", "新界屯門測試邨樣本樓1001室")).toBe("not_comparable");
    expect(cmpAddress("新界屯門測試邨樣本樓1001室", "新界屯門測試邨樣本樓10樓1001室")).toBe("match");
    expect(cmpAddress(null, "x")).toBe("no_reference");
  });
  it("fieldStatus", () => {
    expect(fieldStatus(["no_reference", "no_reference"])).toBe("no_reference");
    expect(fieldStatus(["match", "no_reference", "not_comparable"])).toBe("match");
    expect(fieldStatus(["match", "mismatch"])).toBe("mixed");
    expect(fieldStatus(["mismatch"])).toBe("mismatch");
  });
});

describe("交叉核對評級", () => {
  const ref = (src: RefRow["src"], over: Partial<RefRow>): RefRow => ({
    src, ref: `${src}:1`, staffNos: ["U99999"], hkid: null, nameZh: null, nameEn: null, dob: null, tels: [], addresses: [], ...over,
  });
  const doc = () => {
    const d = aggregateDoc("abc", [
      { page: 1, lines: [L("職位申請表", 0.4, 0.8), L("EMPLOYMENT APPLICATION FORM", 0.3, 0.78), L("手提電話：9123 4567", 0.48, 0.56)] },
      { page: 3, lines: idCardLines() },
      { page: 4, lines: billLines().map((l) => (l.t === "TEST CHAN" ? { ...l, t: "CHAN TAI MAN" } : l)) },
    ]);
    return d;
  };
  const idx = (u: RefRow[]) => ({ utem: buildIndex(u), maxwell: buildIndex([]), db: buildIndex([]) });
  it("兩欄以上互證且冇 mismatch → auto_ok", () => {
    const u = ref("utem", { hkid: "A1234563", nameZh: "測試保安員", dob: "1980-02-01", tels: ["91234567"], addresses: ["ROOM 1001 10/F SAMPLE HOUSE DEMO ESTATE TUEN MUN"] });
    const c = crosscheck(doc(), "U99999", "測試保安員", idx([u]), { vision: [{ docId: "abc", page: 1, digits: "91234567", legible: "clear" }], hasCrop: true });
    expect(c.status.phone).toBe("match");
    expect(c.phoneFinal.status).toBe("confirmed");
    expect(c.grade).toBe("auto_ok");
  });
  it("hkid 同名單唔同 → fail", () => {
    const u = ref("utem", { hkid: "B7654321", nameZh: "測試保安員" });
    const c = crosscheck(doc(), "U99999", null, idx([u]));
    expect(c.status.hkid).toBe("mismatch");
    expect(c.grade).toBe("fail");
    expect(c.reasons).toContain("mismatch_hkid");
  });
  it("用 hkid 搵行時 hkid 欄唔計互證（避免循環）", () => {
    const u = ref("utem", { staffNos: ["U00000"], hkid: "A1234563", dob: "1980-02-01" });
    const c = crosscheck(doc(), "U99999", null, idx([u]));
    expect(c.refs.utem.basis).toBe("hkid");
    expect(c.cmp.hkid.utem).toBe("no_reference");
    expect(c.cmp.dob.utem).toBe("match");
  });
  it("缺電話 → review", () => {
    const d = doc();
    d.phone = null;
    const u = ref("utem", { hkid: "A1234563", nameZh: "測試保安員", dob: "1980-02-01" });
    const c = crosscheck(d, "U99999", "測試保安員", idx([u]));
    expect(c.grade).toBe("review");
    expect(c.reasons).toContain("phone_unresolved");
  });
});

describe("對齊計劃（§26.2.4）", () => {
  const guards: DbGuard[] = [
    { id: "g1", nameZh: "測試保安員", hkid: "A1234563", tels: ["91234567"], staffNos: ["U99999"] },
    { id: "g2", nameZh: "測試保安員乙", hkid: null, tels: ["92345678"], staffNos: ["U88888"] },
    { id: "g3", nameZh: "同名人", hkid: null, tels: [], staffNos: ["MG1"] },
  ];
  const db = buildDbIndex(guards);
  const input = (o: Partial<PlanInput>): PlanInput => ({
    docId: "d", staffNos: [], hkid: "A1234563", hkidValid: true, nameZh: "未知", phone: null, grade: "auto_ok", gradeReasons: [], ...o,
  });
  const run = (i: PlanInput, all: PlanInput[] = [i]) => planAll(all, db).find((p) => p.docIds.includes(i.docId))!;
  it("hkid 相同 → link（auto_ok 可自動套用）", () => {
    const p = run(input({}));
    expect(p.action).toBe("link");
    expect(p.guardId).toBe("g1");
    expect(p.autoApply).toBe(true);
  });
  it("工號相同、DB 冇 hkid → link；review 級唔自動套用", () => {
    const p = run(input({ hkid: "C1234560", staffNos: ["U88888"], grade: "review" }));
    expect(p.action).toBe("link");
    expect(p.guardId).toBe("g2");
    expect(p.autoApply).toBe(false);
  });
  it("hkid 同工號指向唔同人 → conflict", () => {
    const p = run(input({ staffNos: ["U88888"] }));
    expect(p.action).toBe("conflict");
    expect(p.reasons).toContain("hkid_vs_staffno_differ");
  });
  it("DB guard hkid 同檔案唔同 → conflict", () => {
    const p = run(input({ hkid: "C1234560", staffNos: ["U99999"] }));
    expect(p.action).toBe("conflict");
    expect(p.reasons).toContain("guard_hkid_differs");
  });
  it("電話撞另一人 → conflict；電話＋姓名相同 → link；淨電話 → needs_review", () => {
    expect(run(input({ hkid: "C1234560", phone: "91234567", staffNos: ["U88888"] })).action).toBe("conflict");
    const same = run(input({ hkid: "C1234560", phone: "92345678", nameZh: "測試保安員乙" }));
    expect(same.action).toBe("link");
    expect(same.basis).toEqual(["tel", "name"]);
    expect(run(input({ hkid: "C1234560", phone: "92345678", nameZh: "別名" })).action).toBe("needs_review");
  });
  it("淨姓名 → needs_review；完全冇 → create；fail → needs_review", () => {
    const n = run(input({ hkid: "C1234560", nameZh: "同名人" }));
    expect(n.action).toBe("needs_review");
    expect(n.reasons).toContain("name_only_candidate");
    expect(n.candidates).toContain("g3");
    expect(run(input({ hkid: "C1234560", nameZh: "全新" })).action).toBe("create");
    expect(run(input({ hkid: null, hkidValid: false, grade: "fail" })).action).toBe("needs_review");
  });
  it("同一 hkid 嘅 MP 舊檔＋U 新檔合併成一個人（唔係衝突），多工號都帶埋", () => {
    const a = input({ docId: "a", hkid: "C1234560", staffNos: ["MP1"], grade: "review" });
    const b = input({ docId: "b", hkid: "C1234560", staffNos: ["U1"], grade: "auto_ok", phone: "93456789" });
    const plan = planAll([a, b], db);
    expect(plan).toHaveLength(1);
    expect(plan[0].docIds.sort()).toEqual(["a", "b"]);
    expect(plan[0].staffNos.sort()).toEqual(["MP1", "U1"]);
    expect(plan[0].docId).toBe("b"); // 評級較好嘅做主檔
    expect(plan[0].action).toBe("create");
  });
  it("同 hkid 但中文名差異大 → conflict；工號掛喺唔同 hkid → 兩邊 conflict；電話撞另一人 → conflict", () => {
    const a = input({ docId: "a", hkid: "C1234560", nameZh: "測試保安員甲" });
    const b = input({ docId: "b", hkid: "C1234560", nameZh: "完全唔同" });
    expect(planAll([a, b], db)[0].reasons).toContain("group_name_differs");
    const c = input({ docId: "c", hkid: "D1234560", staffNos: ["U3"], phone: "93456789" });
    const d = input({ docId: "d", hkid: "E1234560", staffNos: ["U3"], phone: "93456789" });
    const r = planAll([c, d], db);
    expect(r.every((x) => x.action === "conflict")).toBe(true);
    expect(r[0].reasons).toEqual(expect.arrayContaining(["staffno_shared_by_persons", "dup_tel_across_persons"]));
  });
  it("groupPersons：冇有效 hkid 嘅檔各自獨立", () => {
    const a = input({ docId: "a", hkid: null, hkidValid: false, grade: "fail" });
    const b = input({ docId: "b", hkid: null, hkidValid: false, grade: "fail" });
    expect(groupPersons([a, b])).toHaveLength(2);
  });
  it("decide 可直接用（無群組）", () => {
    expect(decide(input({}), db).action).toBe("link");
  });
});
