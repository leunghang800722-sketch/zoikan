// TE-8：printed HKID 防誤中——token 邊界、label 優先、跨頁多值跳過、裁圖連 label。全部合成（假號碼 X＋6 位數字＋(A)；證書序號 checksum 巧合通過）。
import { describe, it, expect } from "vitest";
import { findHkidTokens, hkidCheckDigitValid } from "../scripts/staff-import/lib/hkid";
import { extractPermit, scanPageHkids } from "../scripts/staff-import/lib/extract";
import { aggregateDoc } from "../scripts/staff-import/lib/aggregate";
import { findPrintedHkidLines, planRequests } from "../scripts/staff-import/lib/triage-evidence-core";
import { emptyStats, produceItems, type Deps, type PersonInput } from "../scripts/staff-import/20-triage-evidence";
import type { OcrLine, OcrPage } from "../scripts/staff-import/lib/ocr";
import { auditOne, summarizeAudit, isAffected } from "../scripts/staff-import/lib/printed-audit";
import { dryPersons, run as runAudit, parseArgs as auditArgs } from "../scripts/staff-import/21-printed-audit";
import type { PkgPerson } from "../scripts/staff-import/lib/triage-reread-core";

const L = (t: string, x: number, y: number, w = 0.5): OcrLine => ({ t, c: 0.9, x, y, w, h: 0.02 });
/** 證書序號：4 字母開頭＋7 位數字，內含 TW102624(c) 子串而且 checksum 巧合通過 */
const SERIAL = (() => {
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((d) => hkidCheckDigitValid(`TW102624${d}`))!;
  return `QATW102624${c}`;
})();
/** check digit 係字母 A 嘅合法號碼（X＋6 位數字） */
const DIG = (() => {
  for (let n = 100000; n < 999999; n++) if (hkidCheckDigitValid(`X${n}A`)) return String(n);
  throw new Error("no A");
})();
const REAL = `X${DIG}A`;
const RAW = `X${DIG}（A）`;
const page = (): OcrLine[] => [L(`：${SERIAL}`, 0.4, 0.89), L(`CHAN TAI MAN I. D. Card No: ${RAW}`, 0.1, 0.62, 0.7), L(`身份證號碼：${RAW}`, 0.1, 0.45)];

describe("token 邊界", () => {
  it("證書序號內嘅子串唔算候選；單獨出現先算", () => {
    expect(findHkidTokens(`：${SERIAL}`)).toEqual([]);
    expect(findHkidTokens(SERIAL.slice(2))).toHaveLength(1); // TW102624c 單獨一串（前後冇英數字）＝形狀合法候選；邊界只擋「緊貼其他英數字」
  });
  it("單獨一串 TW102624c 係合法形狀（兩個字母前綴）；括號 check digit 本身係邊界", () => {
    const c = SERIAL.slice(-1);
    expect(findHkidTokens(`TW102624(${c})`).map((t) => t.value)).toEqual([`TW102624${c}`]);
    expect(findHkidTokens(`QA TW102624(${c})`).length).toBe(1);
    expect(findHkidTokens(`QATW102624(${c})`)).toEqual([]);
  });
});

describe("scanPageHkids：label 優先", () => {
  it("同頁有序號＋兩行有 label 嘅真號碼（check digit A、全形括號）→ 只出 label 候選（同一號碼一條），序號唔出", () => {
    const r = scanPageHkids(1, page());
    expect(r.map((f) => f.value)).toEqual([REAL]);
    expect(r[0]!.flags).toContain("hkid_labelled");
  });
  it("純序號頁 → 唔出；冇 label 嘅純英數串（冇括號）唔收；冇 label 但有括號 check digit 先收", () => {
    expect(scanPageHkids(1, [L(`：${SERIAL}`, 0.4, 0.89), L("QASRS CERTIFICATE", 0.1, 0.95)])).toEqual([]);
    expect(scanPageHkids(1, [L(`${REAL}`, 0.1, 0.5)])).toEqual([]);
    expect(scanPageHkids(1, [L(`X${DIG}(A)`, 0.1, 0.5)]).map((f) => f.value)).toEqual([REAL]);
  });
  it("label 喺上一行（淨 label）、號碼喺下一行", () => {
    const r = scanPageHkids(1, [L("身份證號碼：", 0.1, 0.6, 0.2), L(`${RAW}`, 0.1, 0.57, 0.2)]);
    expect(r.map((f) => f.value)).toEqual([REAL]);
  });
  it("label 候選同無 label 候選並存 → 只出 label 嗰個", () => {
    const r = scanPageHkids(1, [L("身份證號碼：A123456(3)", 0.1, 0.6), L(`X${DIG}(A)`, 0.1, 0.3)]);
    expect(r.map((f) => f.value)).toEqual(["A1234563"]);
  });
});

describe("跨頁多個唔同值", () => {
  it("aggregateDoc：兩頁 label 號碼唔同 → printedHkid null＋hkid_printed_multiple；一致 → 出一個", () => {
    const pg = (n: number, t: string): OcrPage => ({ page: n, lines: [L("某某證書 Certificate", 0.1, 0.9), L(t, 0.1, 0.5)] });
    const diff = aggregateDoc("x", [pg(1, `身份證號碼：${RAW}`), pg(2, "身份證號碼：A123456（3）")]);
    expect(diff.aux.printedHkid).toBeNull();
    expect(diff.flags).toContain("hkid_printed_multiple");
    expect(diff.hkid).toBeNull();
    const same = aggregateDoc("x", [pg(1, `身份證號碼：${RAW}`), pg(2, `I.D. Card No: ${RAW}`)]);
    expect(same.aux.printedHkid?.value).toBe(REAL);
  });
  const lf = (value: string | null) => ({ value, status: "missing" as const });
  const person = { key: "pk", hkid: lf(null), nameZh: lf(null), nameEn: lf(null), dateOfBirth: lf(null), phone: lf(null), address: lf(null), staffNumbers: [{ number: "U8" }], rating: "review" } as unknown as PkgPerson;
  const mkDeps = (byDoc: Record<string, OcrLine[]>): Deps => ({ lines: async (d) => byDoc[d.docId] ?? null, existing: () => null, render: async () => null, cleanup: async () => undefined });
  it("腳本 produceItems：兩個唔同 label 號碼 → printed_multiple（唔出 printed 圖、計數）；一致 → planRequests 出 2 張（label 行優先）", async () => {
    const pi = (): PersonInput => ({ person, docs: [], scanPages: [{ docId: "a", page: 1 }, { docId: "b", page: 1 }] });
    const stats = emptyStats();
    await produceItems([pi()], mkDeps({ a: [L(`身份證號碼：${RAW}`, 0.1, 0.5)], b: [L("身份證號碼：A123456（3）", 0.1, 0.5)] }), stats);
    expect(stats.skipped.printed_multiple).toBe(1);
    expect(stats.skipped_by_field.hkid?.printed_multiple).toBe(1);
    const stats2 = emptyStats();
    await produceItems([pi()], mkDeps({ a: [L(`身份證號碼：${RAW}`, 0.1, 0.5)], b: [L(`I.D. Card No: ${RAW}`, 0.1, 0.5)] }), stats2);
    expect(stats2.skipped.printed_multiple).toBeUndefined();
    const printedA = findPrintedHkidLines([L(`身份證號碼：${RAW}`, 0.1, 0.5)], 0.7);
    const reqs = planRequests(["hkid"], [], { printed: [{ doc: { type: "id_card", docId: "a", page: 1 }, rot: 0, line: printedA[0]!.line }, { doc: { type: "id_card", docId: "b", page: 1 }, rot: 0, line: printedA[0]!.line }, { doc: { type: "id_card", docId: "c", page: 1 }, rot: 0, line: printedA[0]!.line }] });
    expect(reqs.filter((r) => r.printed)).toHaveLength(2); // 最多 2 張
  });
});

describe("裁圖連 label", () => {
  it("同行：由 label 起裁到號碼尾（唔係淨得號碼）；序號行唔出", () => {
    const rs = findPrintedHkidLines(page(), 0.7);
    expect(rs.map((r) => r.value)).toEqual([REAL, REAL]);
    const sameLine = rs.find((r) => r.line.t.includes("身份證號碼"))!;
    // 「身份證號碼：${RAW}」整行（label 喺行首）→ 範圍約等於整行
    expect(sameLine.line.x).toBeCloseTo(0.1, 1);
    expect(sameLine.line.w).toBeGreaterThan(0.4);
    const mixed = rs.find((r) => r.line.t.includes("CHAN"))!;
    // 「<英文名> I. D. Card No: ${RAW}」：label 之前嘅英文名唔入圖——起點右移
    expect(mixed.line.x).toBeGreaterThan(0.1 + 0.7 * 0.2);
    expect(rs.find((r) => r.labelled)).toBeTruthy();
  });
  it("label 喺上一行：聯合兩行 box（含 label 行同號碼行）", () => {
    const rs = findPrintedHkidLines([L("身份證號碼：", 0.1, 0.6, 0.2), L(`${RAW}`, 0.1, 0.57, 0.2)], 0.7);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.line.y).toBeCloseTo(0.57, 5);
    expect(rs[0]!.line.y + rs[0]!.line.h).toBeCloseTo(0.62, 5); // 到 label 行頂
    expect(rs[0]!.line.t).toContain("身份證號碼");
  });
  it("純序號頁 → 冇 printed 行", () => {
    expect(findPrintedHkidLines([L(`：${SERIAL}`, 0.4, 0.89)], 0.7)).toEqual([]);
  });
});

describe("全庫自檢（printed-audit）", () => {
  it("老闆個案：舊規則第一候選＝嵌入序號（錯），新規則→兩行 label 候選同一值；摘要只有計數", () => {
    const row = auditOne({ key: "k", pages: [{ docId: "d", page: 1, lines: page() }] });
    expect(row).toMatchObject({ oldFound: true, oldEmbedded: true, oldNoLabel: true, newFound: true, multi: false, changed: true, newLabelled: true });
    expect(isAffected(row)).toBe(true);
    const clean = auditOne({ key: "c", pages: [{ docId: "d", page: 1, lines: [L("身份證號碼：A123456（3）", 0.1, 0.5)] }] });
    expect(clean).toMatchObject({ oldEmbedded: false, oldNoLabel: false, changed: false });
    expect(isAffected(clean)).toBe(false);
    const s = summarizeAudit([row, clean]);
    expect(s).toMatchObject({ persons: 2, old_found: 2, old_embedded: 1, new_found: 2, changed: 1 });
  });
  it("--dry：固定 fixture 計數（舊規則嵌入序號 2、多值衝突 1、新舊唔同 3）；受影響 personKey 清單冇號碼值", async () => {
    const r = await runAudit(auditArgs(["--dry"]));
    expect(dryPersons()).toHaveLength(5);
    expect(r.summary).toMatchObject({ persons: 5, old_found: 4, old_embedded: 2, old_no_label: 2, new_found: 2, new_labelled: 2, multi_conflict: 1, changed: 3 });
    expect(r.affected.map((a) => a.person_key).sort()).toEqual(["dry-1", "dry-2", "dry-3"]);
    expect(JSON.stringify(r)).not.toMatch(/A123456|Z900001|QATW/);
  });
});

describe("TE-8 S1：extractPermit 整行淨號碼後備", () => {
  it("Permit No 下一行嘅號碼（checksum 巧合）唔當身份證號；單獨一行先後備（level low）", () => {
    expect(hkidCheckDigitValid("A1000007")).toBe(true);
    const under = [L("保安人員許可證", 0.1, 0.9), L("許可證編號 Permit No", 0.1, 0.8, 0.4), L("A1000007", 0.1, 0.77, 0.2)];
    expect(extractPermit(1, under).hkid).toBeNull();
    const under2 = [L("PERMIT NO.", 0.1, 0.8, 0.4), L("A1000007", 0.1, 0.77, 0.2)];
    expect(extractPermit(1, under2).hkid).toBeNull();
    const alone = extractPermit(1, [L("保安人員許可證", 0.1, 0.9), L("A1000007", 0.1, 0.6, 0.2)]);
    expect(alone.hkid).toMatchObject({ value: "A1000007", level: "low" });
  });
});
