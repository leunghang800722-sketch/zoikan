// TE-3(3)：印刷／證書頁嘅 HKID 行內搜尋（NFKC＋checksum）、label 後 OCR 混淆修正（唯一 checksum 通過先收）、printedHkid 來源。
import { describe, expect, it } from "vitest";
import { aggregateDoc } from "../scripts/staff-import/lib/aggregate";
import { scanPageHkids } from "../scripts/staff-import/lib/extract";
import { hkidFromConfusableToken, findHkidTokens, looksLikeDateOrPhone } from "../scripts/staff-import/lib/hkid";
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
  it("findHkidTokens：NFKC、全形括號、有 token 邊界", () => {
    const t = findHkidTokens("身份證號碼 A123456(3) 簽發")[0]!;
    expect(t).toMatchObject({ value: "A1234563", bracketed: true });
    expect(t.start).toBeGreaterThan(0);
    expect(findHkidTokens("x A123456（3） y").map((x) => x.value)).toEqual(["A1234563"]);
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

describe("TE-3 M1 混淆修正收緊", () => {
  it("(a) 只收同一行緊跟 label 嘅 token；下一行後備淨限該行只有 token", () => {
    expect(scanPageHkids(1, [L("身份證號碼 2900001(2) 簽發")]).map((f) => f.value)).toEqual(["Z9000012"]);
    // label 唔喺 token 前面（token 喺 label 之前／中間夾其他字）→ 唔收
    expect(scanPageHkids(1, [L("2900001(2) 身份證號碼")])).toEqual([]);
    expect(scanPageHkids(1, [L("身份證號碼 簽發 2900001(2)")])).toEqual([]);
    // 下一行有 token 但夾住其他字 → 唔收；淨 token 先收
    expect(scanPageHkids(1, [L("身份證號碼", 0.1, 0.6, 0.2), L("2900001(2) 出生日期 1990", 0.1, 0.57, 0.5)])).toEqual([]);
    expect(scanPageHkids(1, [L("身份證號碼", 0.1, 0.6, 0.2), L("2900001(2)", 0.1, 0.57, 0.2)]).map((f) => f.value)).toEqual(["Z9000012"]);
  });
  it("(b) 似日期（ddmmyyyy／yyyymmdd）／似電話（5／6／9 開頭 8 位）嘅 token 拒絕", () => {
    expect(looksLikeDateOrPhone("15011990")).toBe(true);
    expect(looksLikeDateOrPhone("19900115")).toBe(true);
    expect(looksLikeDateOrPhone("91234567")).toBe(true);
    expect(looksLikeDateOrPhone("29000012")).toBe(false);
    expect(hkidFromConfusableToken("1501199(0)")).toBeNull();
    expect(hkidFromConfusableToken("9123456 7")).toBeNull();
  });
  it("(c) 冇結構線索（括號／空格 check digit）唔修正", () => {
    expect(hkidFromConfusableToken("29000012")).toBeNull();
    expect(hkidFromConfusableToken("2900001(2)")?.value).toBe("Z9000012");
    expect(hkidFromConfusableToken("2900001(2")?.value).toBe("Z9000012"); // 右括號缺
    expect(hkidFromConfusableToken("2900001 2")?.value).toBe("Z9000012");
  });
  it("(d) 修正值 level low＋note；aggregate：唔可獨力當 hkid 後備；有獨立（未修正）來源一致先用；唔做 corroborated 替換", () => {
    const f = scanPageHkids(1, [L("身份證號碼 2900001(2)")])[0]!;
    expect(f).toMatchObject({ level: "low", note: "ocr_confusion_fixed" });
    const page = (t: string): OcrPage => ({ page: 1, lines: [L("某某證書 Certificate"), L(t)] });
    const alone = aggregateDoc("x", [page("身份證號碼 2900001(2)")]);
    expect(alone.hkid).toBeNull();
    expect(alone.aux.printedHkid?.note).toBe("ocr_confusion_fixed");
    // 另一頁有未修正嘅同值 → 該（未修正）值被揀作 printedHkid，後備可用
    const both = aggregateDoc("x", [page("身份證號碼 2900001(2)"), { page: 2, lines: [L("另一證書"), L("身份證號碼 Z900001(2)")] }]);
    expect(both.hkid?.value).toBe("Z9000012");
    expect(both.hkid?.level).toBe("low");
  });
  it("誤收率回歸：隨機 8 位數字／ddmmyyyy 日期／電話各 2000 個，誤收 ≤0.5%（含「身份證號碼」label，純數字 token）", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const digits8 = () => Array.from({ length: 8 }, () => Math.floor(rnd() * 10)).join("");
    const date = () => {
      const d = 1 + Math.floor(rnd() * 28);
      const m = 1 + Math.floor(rnd() * 12);
      const y = 1950 + Math.floor(rnd() * 60);
      return `${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}${y}`;
    };
    const phone = () => `${[5, 6, 9][Math.floor(rnd() * 3)]}${Array.from({ length: 7 }, () => Math.floor(rnd() * 10)).join("")}`;
    const forms = (d: string) => [d, `${d.slice(0, 7)}(${d[7]})`, `${d.slice(0, 7)} ${d[7]}`];
    const rate = (gen: () => string, withClue: boolean) => {
      let bad = 0;
      for (let i = 0; i < 2000; i++) {
        const d = gen();
        const tok = forms(d)[withClue ? 1 + (i % 2) : 0]!;
        if (scanPageHkids(1, [L(`身份證號碼 ${tok}`)]).length > 0) bad++;
      }
      return bad / 2000;
    };
    expect(rate(digits8, false)).toBeLessThanOrEqual(0.005); // 純數字冇結構線索
    expect(rate(date, false)).toBeLessThanOrEqual(0.005);
    expect(rate(phone, false)).toBeLessThanOrEqual(0.005);
    expect(rate(date, true)).toBeLessThanOrEqual(0.005); // 日期即使套上括號結構亦拒
    expect(rate(phone, true)).toBeLessThanOrEqual(0.005);
  });
  it("已知水平：隨機 7 位數字＋(d) 結構（check digit 巧合通過）誤收 ≤10%——靠唯一 checksum＋low 唔獨力採用兜住", () => {
    let seed = 987;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let bad = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const d7 = Array.from({ length: 7 }, () => Math.floor(rnd() * 10)).join("");
      const tok = `${d7}(${Math.floor(rnd() * 10)})`;
      const r = scanPageHkids(1, [L(`身份證號碼 ${tok}`)]);
      if (r.length) {
        bad++;
        expect(r[0]).toMatchObject({ level: "low", note: "ocr_confusion_fixed" }); // 誤收都只係 low
      }
    }
    expect(bad / N).toBeLessThanOrEqual(0.1);
  });
});
