// WP-LTSHIFT §19：`src/lib/guard-fix/postorder.ts` 純函數單元測試——用
// 合成 workbook（唔碰真實 `data/2026-09/msg-file/Postorder - Aug
// 2026.xlsm`，鐵則：test 唔准帶真名），覆蓋 Roster「(8) 長工」格解析＋
// PostOrder「長工雞頭費」公式行解析＋visa stub。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  parsePostorderLongtermPostsFromWorkbook,
  parsePostorderReferralRowsFromWorkbook,
  parsePostorderVisaStaff,
  summarizePostorderParse,
} from "@/lib/guard-fix/postorder";

/** 起一個同真實 Postorder 檔一致欄位排位嘅合成 Roster sheet：col A 客戶
 * 名稱／C 物業名稱／逐日 7 欄由 col H(8) 起 [日期,雞頭名,備註,其他,救更
 * 價,Unbilled,Paid]。 */
function buildRosterSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Roster");
  // WP-POSTORDER-ROBUST：表頭唔再靠寫死行／欄位置，解析器由「客戶名稱」
  // ／「物業名稱」／「雞頭名」呢類字眼自己搵——fixture 要帶齊呢啲字眼
  // （同真樣本一致：逐日 block 由「雞頭名」子欄起，「備註」隔籬）。
  ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "1-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "2-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "3-8月", "雞頭名", "備註"];
  // row9：日1／日2 都係 "(8) 長工"，備註「甲蟲蟲」；日3 淦頂散更（唔算長工格）
  ws.getCell("A9").value = "測試盤 甲蟲蟲";
  ws.getCell("C9").value = "測試";
  ws.getCell("I9").value = "(8) 長工"; // day1 broker col = 9
  ws.getCell("J9").value = "甲蟲蟲"; // day1 note col = 10
  ws.getCell("P9").value = "(8) 長工"; // day2 broker col = 9+7=16
  ws.getCell("Q9").value = "甲蟲蟲"; // day2 note col = 17
  ws.getCell("W9").value = "(2) 淦"; // day3 broker col = 9+14=23
  ws.getCell("X9").value = "乙屎蟲"; // day3 note（唔係長工格，唔計）

  // row10：另一個人喺另一個盤，1 格長工
  ws.getCell("A10").value = "另一盤 乙屎蟲";
  ws.getCell("C10").value = "另一";
  ws.getCell("I10").value = "(8) 長工";
  ws.getCell("J10").value = "乙屎蟲";
  return ws;
}

function buildPostOrderSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("PostOrder");
  ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間"];
  // 兩個「員工行」——col A 帶盤名+人名尾段，col AM(39) 係總更數
  ws.getCell("A8").value = "測試盤 甲蟲蟲";
  ws.getCell("C8").value = "測試";
  ws.getCell(8, 39).value = 20; // AM
  ws.getCell("A9").value = "測試盤 丙金蟲";
  ws.getCell("C9").value = "測試";
  ws.getCell(9, 39).value = 5; // AM

  // 介紹費行：col A「長工雞頭費 (淦)」，col F 公式 `=50*SUM(AM8,AM9)`
  ws.getCell("A10").value = "長工雞頭費 (淦)";
  ws.getCell("C10").value = "淦";
  ws.getCell("F10").value = { formula: "50*SUM(AM8,AM9)", result: 1250 };
  return ws;
}

describe("WP-LTSHIFT postorder parser（合成 workbook）", () => {
  it("parsePostorderLongtermPostsFromWorkbook：淨計「(8) 長工」格，跳過雞頭頂更格", async () => {
    const wb = new ExcelJS.Workbook();
    buildRosterSheet(wb);
    const posts = parsePostorderLongtermPostsFromWorkbook(wb);
    expect(posts).toHaveLength(2);
    const bySite = new Map(posts.map((p) => [p.guardNameRaw, p]));
    expect(bySite.get("甲蟲蟲")?.cellCount).toBe(2); // day1+day2，day3 淦頂更唔計
    expect(bySite.get("甲蟲蟲")?.siteLabelRaw).toBe("測試盤"); // col A 去咗人名尾段
    expect(bySite.get("乙屎蟲")?.cellCount).toBe(1);
    expect(bySite.get("乙屎蟲")?.siteLabelRaw).toBe("另一盤");
  });

  it("parsePostorderLongtermPostsFromWorkbook：物業名稱空（section header）嘅行跳過（冇上一個值可以補）", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Roster");
    ws.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "1-8月", "雞頭名", "備註"];
    ws.getCell("A8").value = "測試盤 12hrs (D/S)"; // section header 行，冇 C 欄（物業名稱），亦冇上一行可以向下補值
    ws.getCell("I8").value = "(8) 長工"; // 就算呢行有長工標記，冇 prop 都唔計（保守，唔屈估）
    ws.getCell("J8").value = "甲蟲蟲";
    const posts = parsePostorderLongtermPostsFromWorkbook(wb);
    expect(posts).toHaveLength(0);
  });

  it("parsePostorderReferralRowsFromWorkbook：由公式讀返 rate／shifts／site／人名", async () => {
    const wb = new ExcelJS.Workbook();
    buildPostOrderSheet(wb);
    const rows = parsePostorderReferralRowsFromWorkbook(wb);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.brokerLabelRaw).toBe("淦");
    expect(r.rate).toBe(50);
    expect(r.shifts).toBe(25); // 20+5
    expect(r.excelAmount).toBe(1250);
    expect(r.guardNamesRaw.sort()).toEqual(["丙金蟲", "甲蟲蟲"]);
    expect(r.siteLabelsRaw).toEqual(["測試盤"]);
  });

  it("parsePostorderReferralRowsFromWorkbook：冇 PostOrder sheet 就返空 array（唔 throw）", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Roster");
    expect(parsePostorderReferralRowsFromWorkbook(wb)).toEqual([]);
  });

  it("parsePostorderVisaStaff：老實答 unsupported（Postorder 冇顯式簽證標記）", () => {
    const wb = new ExcelJS.Workbook();
    const result = parsePostorderVisaStaff(wb);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/簽證/);
  });

  it("summarizePostorderParse：淨係數目，冇任何人名字串", async () => {
    const wb = new ExcelJS.Workbook();
    buildRosterSheet(wb);
    buildPostOrderSheet(wb);
    const posts = parsePostorderLongtermPostsFromWorkbook(wb);
    const referralRows = parsePostorderReferralRowsFromWorkbook(wb);
    const visa = parsePostorderVisaStaff(wb);
    const summary = summarizePostorderParse({
      longtermPosts: posts,
      referralRows,
      visa,
      missingSheets: [],
      rosterHeaderRow: 7,
      rosterDayBlockWidth: 7,
      rosterFirstDayCol: 8,
      rosterParseError: null,
      postorderCsvText: null,
    });
    const json = JSON.stringify(summary);
    expect(json).not.toMatch(/甲蟲蟲|乙屎蟲|丙金蟲/);
    expect(summary.longterm_cell_count).toBe(3);
    expect(summary.referral_row_count).toBe(1);
    expect(summary.referral_total_excel_amount).toBe(1250);
  });
});
