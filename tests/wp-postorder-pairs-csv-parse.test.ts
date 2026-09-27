// WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：`parseLongtermPairsCsv()`／
// `parsePostorderFromPairsCsv()` 純函數單元測試——同 `tests/wp-ltshift-
// postorder-parse.test.ts` 一致風格，合成 CSV 文字，唔碰真名。
//
// 鐵則：合成 fixture 用假人名。
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseLongtermPairsCsv,
  parsePostorderFromPairsCsv,
  parsePostorderLongtermPostsFromWorkbook,
  loadPostorderWorkbook,
} from "@/lib/guard-fix/postorder";

const VALID_CSV = ["site_label,site_short,guard_name,cell_count", "測試盤 甲蟲蟲,測試,甲蟲蟲,10", "另一盤 乙屎蟲,另一,乙屎蟲,5"].join("\r\n") + "\r\n";

describe("WP-POSTORDER-PAIRS-CSV：parseLongtermPairsCsv()", () => {
  it("有效 CSV → 逐行解析做 PostorderLongtermPostCell", () => {
    const outcome = parseLongtermPairsCsv(VALID_CSV);
    expect(outcome.parseError).toBeNull();
    expect(outcome.cells).toEqual([
      { siteLabelRaw: "測試盤 甲蟲蟲", siteLabelFallbackRaw: "測試", guardNameRaw: "甲蟲蟲", cellCount: 10 },
      { siteLabelRaw: "另一盤 乙屎蟲", siteLabelFallbackRaw: "另一", guardNameRaw: "乙屎蟲", cellCount: 5 },
    ]);
  });

  it("UTF-8 BOM＋CRLF 都要認得", () => {
    const withBom = "﻿" + VALID_CSV.replace(/\n/g, "\r\n");
    const outcome = parseLongtermPairsCsv(withBom);
    expect(outcome.parseError).toBeNull();
    expect(outcome.cells).toHaveLength(2);
    expect(outcome.cells.reduce((acc, c) => acc + c.cellCount, 0)).toBe(15);
  });

  it("表頭錯（欄名唔啱／少咗一欄）→ parseError，唔靜靜當 0", () => {
    const badHeader = "site,site_short,guard_name,cell_count\n測試盤,測試,甲蟲蟲,10\n";
    const outcome = parseLongtermPairsCsv(badHeader);
    expect(outcome.parseError).toMatch(/表頭/);
    expect(outcome.cells).toEqual([]);
  });

  it("cell_count 非整數（例如帶小數點或文字）→ parseError", () => {
    const badCount = "site_label,site_short,guard_name,cell_count\n測試盤 甲蟲蟲,測試,甲蟲蟲,3.5\n";
    const outcome = parseLongtermPairsCsv(badCount);
    expect(outcome.parseError).toMatch(/cell_count/);
    expect(outcome.cells).toEqual([]);
  });

  it("cell_count 係空白文字（非數字）→ parseError", () => {
    const badCount = "site_label,site_short,guard_name,cell_count\n測試盤 甲蟲蟲,測試,甲蟲蟲,唔知幾多\n";
    const outcome = parseLongtermPairsCsv(badCount);
    expect(outcome.parseError).toMatch(/cell_count/);
  });

  it("某一行缺欄（guard_name 空白）→ parseError", () => {
    const missingCol = "site_label,site_short,guard_name,cell_count\n測試盤 甲蟲蟲,測試,,10\n";
    const outcome = parseLongtermPairsCsv(missingCol);
    expect(outcome.parseError).toMatch(/缺欄/);
  });

  it("空 CSV（一行都冇）→ parseError", () => {
    const outcome = parseLongtermPairsCsv("");
    expect(outcome.parseError).toMatch(/空/);
  });

  it("表頭大小寫唔敏感（SITE_LABEL 都認得）", () => {
    const upperHeader = "SITE_LABEL,SITE_SHORT,GUARD_NAME,CELL_COUNT\n測試盤 甲蟲蟲,測試,甲蟲蟲,10\n";
    const outcome = parseLongtermPairsCsv(upperHeader);
    expect(outcome.parseError).toBeNull();
    expect(outcome.cells).toHaveLength(1);
  });
});

describe("WP-POSTORDER-PAIRS-CSV：parsePostorderFromPairsCsv()", () => {
  it("冇帶 postorder_csv → referralRows 空、missingSheets 記低 PostOrder", () => {
    const result = parsePostorderFromPairsCsv({ longtermPairsCsv: VALID_CSV, postorderCsv: null });
    expect(result.longtermPosts).toHaveLength(2);
    expect(result.referralRows).toEqual([]);
    expect(result.missingSheets).toEqual(["PostOrder"]);
    expect(result.rosterParseError).toBeNull();
    expect(result.rosterHeaderRow).toBeNull();
  });

  it("pairs CSV 表頭錯 → rosterParseError 帶原因，唔會 throw", () => {
    const result = parsePostorderFromPairsCsv({ longtermPairsCsv: "唔啱嘅表頭\n1,2,3\n", postorderCsv: null });
    expect(result.longtermPosts).toEqual([]);
    expect(result.rosterParseError).toMatch(/表頭/);
  });
});

// ---------------------------------------------------------------------------
// 真檔比對（skipIf）：`data/2026-09/msg-file/Postorder - Aug 2026.xlsm`
// （gitignored，冇呢個檔嘅環境自動 skip）——`export-postorder-pairs.ts`
// 匯出嘅 `longterm-pairs.csv` 重新解析，同直接讀 xlsm 嘅結果組數／格數
// 逐項相等。
// ---------------------------------------------------------------------------
const REAL_POSTORDER_FILE = path.resolve(__dirname, "../data/2026-09/msg-file/Postorder - Aug 2026.xlsm");
const hasRealFile = existsSync(REAL_POSTORDER_FILE);

describe.skipIf(!hasRealFile)("WP-POSTORDER-PAIRS-CSV：真檔 xlsm 路徑 vs 匯出 longterm-pairs.csv 重新解析（data/ gitignored，冇呢個檔嘅環境自動 skip）", () => {
  it("組數／逐組格數逐項相等", async () => {
    const buffer = await readFile(REAL_POSTORDER_FILE);
    const wb = await loadPostorderWorkbook(buffer);
    const fromWorkbook = parsePostorderLongtermPostsFromWorkbook(wb);

    // 同 scripts/guard-fix/export-postorder-pairs.ts 一致嘅 CSV escape／
    // 排序邏輯，直接喺 memory 做（唔寫檔），逼真模擬匯出→重新解析嘅
    // 一致性。
    function csvEscape(s: string): string {
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    const sorted = [...fromWorkbook].sort((a, b) => {
      const bySite = a.siteLabelRaw.localeCompare(b.siteLabelRaw, "zh-Hant");
      if (bySite !== 0) return bySite;
      return a.guardNameRaw.localeCompare(b.guardNameRaw, "zh-Hant");
    });
    const csvText =
      ["site_label,site_short,guard_name,cell_count", ...sorted.map((c) => [csvEscape(c.siteLabelRaw), csvEscape(c.siteLabelFallbackRaw ?? ""), csvEscape(c.guardNameRaw), String(c.cellCount)].join(","))].join(
        "\r\n",
      ) + "\r\n";

    const outcome = parseLongtermPairsCsv(csvText);
    expect(outcome.parseError).toBeNull();
    expect(outcome.cells).toHaveLength(fromWorkbook.length);
    expect(outcome.cells.reduce((acc, c) => acc + c.cellCount, 0)).toBe(fromWorkbook.reduce((acc, c) => acc + c.cellCount, 0));
    console.log(`[wp-postorder-pairs-csv] ${outcome.cells.length} 個 (盤,人) 組合、${outcome.cells.reduce((acc, c) => acc + c.cellCount, 0)} 格——xlsm 直讀 vs pairs-csv 重新解析一致`);
  });
});

