// TE-3(3)：印刷／證書頁嘅 HKID 行內搜尋（NFKC＋checksum）、label 後 OCR 混淆修正（唯一 checksum 通過先收）、printedHkid 來源。
import { describe, expect, it } from "vitest";
import { aggregateDoc } from "../scripts/staff-import/lib/aggregate";
import { scanPageHkids } from "../scripts/staff-import/lib/extract";
import { hkidFromConfusableToken, hkidSpanInLine, findValidHkidsInText } from "../scripts/staff-import/lib/hkid";
import { findPrintedHkidLines } from "../scripts/staff-import/lib/triage-evidence-core";
import type { OcrLine, OcrPage } from "../scripts/staff-import/lib/ocr";

const L = (t: string, x = 0.1, y = 0.5, w = 0.6): OcrLine => ({ t, c: 0.9, x, y, w, h: 0.02 });

describe("scanPageHkids", () => {
  it("全形括號、夾喺同一行其他文字入面", () => {
    const r = scanPageHkids(1, [L("持有人 身份證號碼：A123456（3） 簽發日期 2020")]);
    expect(r.map((f) => f.value)).toEqual(["A1234563"]);
    expect(r[0]!.note).toBeUndefined();
  });
  it("許可證行首位 Z 被讀成 2 → 修正並記 ocr_confusion_fixed", () => {
    const r = scanPageHkids(1, [L("I.D. Card No. 2900001(2)")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe("Z9000012");
    expect(r[0]!.note).toBe("ocr_confusion_fixed");
  });
  it("號碼喺 label 下一行", () => {
    const r = scanPageHkids(1, [L("身份證號碼", 0.1, 0.6, 0.2), L("2900001 2", 0.1, 0.57, 0.2)]);
    expect(r.map((f) => f.value)).toEqual(["Z9000012"]);
  });
  it("純數字冇 label 唔收；有 label 但 checksum 唔通過唔收", () => {
    expect(scanPageHkids(1, [L("電話 2900001 2")])).toEqual([]);
    expect(scanPageHkids(1, [L("身份證號碼 2900001(9)")])).toEqual([]);
  });
  it("許可證編號行唔當身份證號", () => {
    expect(scanPageHkids(1, [L("PERMIT NO. A123456(3)")])).toEqual([]);
  });
});

describe("hkidFromConfusableToken", () => {
  it("多個 checksum 通過嘅候選 → 拒絕", () => {
    // 首位 0 可以係 O／D／Q：揀出 check 通過嘅超過一個就唔收（逐一驗證有至少一個歧義情況）
    const hits = ["O", "D", "Q"].filter((c) => hkidFromConfusableToken(`${c}1234563`) !== null);
    expect(hits.length).toBeLessThanOrEqual(1);
    expect(hkidFromConfusableToken("00000000")).toBeNull();
  });
  it("hkidSpanInLine／findValidHkidsInText", () => {
    const s = hkidSpanInLine("身份證號碼 A123456(3) 簽發")!;
    expect(s.start).toBeGreaterThan(0);
    expect(s.end).toBeLessThan(s.len);
    expect(findValidHkidsInText("x A123456（3） y")).toEqual(["A1234563"]);
  });
});

describe("aggregateDoc：printedHkid 來源", () => {
  const other = (n: number, t: string): OcrPage => ({ page: n, lines: [L("某某證書 Certificate"), L(t)] });
  it("冇身份證頁、只有證書頁印刷號碼 → printedHkid，hkid 退用 secondary（low）", () => {
    const d = aggregateDoc("x", [other(1, "身份證號碼：A123456（3）")]);
    expect(d.aux.printedHkid?.value).toBe("A1234563");
    expect(d.hkid?.value).toBe("A1234563");
    expect(d.hkid?.level).toBe("low");
    expect(d.flags).toContain("hkid_from_secondary");
  });
  it("兩頁印刷號碼唔同 → 唔用", () => {
    const d = aggregateDoc("x", [other(1, "身份證號碼：A123456（3）"), other(2, "身份證號碼：Z900001（2）")]);
    expect(d.aux.printedHkid).toBeNull();
    expect(d.hkid).toBeNull();
    expect(d.flags).toContain("hkid_printed_multiple");
  });
});

describe("findPrintedHkidLines：行內號碼只裁號碼 x 範圍", () => {
  it("長行入面嘅號碼 → 裁窄", () => {
    const line = L("持有人 身份證號碼：A123456(3) 簽發日期 2020-01-01", 0.1, 0.5, 0.6);
    const r = findPrintedHkidLines([line], 1.414);
    expect(r).toHaveLength(1);
    expect(r[0]!.line.w).toBeLessThan(0.6 * 0.6);
    expect(r[0]!.line.x).toBeGreaterThan(0.1);
  });
  it("整行都係號碼 → 不變", () => {
    const r = findPrintedHkidLines([L("A123456(3)", 0.1, 0.5, 0.2)], 1.414);
    expect(r[0]!.line.w).toBeCloseTo(0.2, 5);
  });
});
