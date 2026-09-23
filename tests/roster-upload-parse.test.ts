// WP-ROSTER-UPLOAD Phase A（§15.3）：TS 解析器單元測試——合成 xlsx
// （exceljs 生成，鐵則：唔用真員工資料，名用「測試安員甲/乙/丙」、U 號
// `U9xxxx`、電話 `6xxxxxxx`）覆蓋 8 月試算 7 個 patch 逐個場景。真實
// 36 個 8 月更表嘅整體比對留俾 `npm run gate:roster-parse`（見
// scripts/gate/roster-parse.ts + tests/fixtures/roster-parse-aug-2026.json，
// 嗰個 fixture 本身淨係存數目/日期範圍，冇任何 PII）。
//
// 呢個檔案零 DB 依賴（`parseRosterWorkbook()` 本身純函數），唔使
// `tests/global-setup.ts` 起嘅 embedded postgres，直接 `vitest run` 就得。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseRosterWorkbook } from "@/lib/roster-upload/parse";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("roster-upload parse：standard layout", () => {
  it("基本一個 block，兩個安員、逐日代號", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤A";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("H4").value = aug(2);
    ws.getCell("I4").value = aug(3);
    ws.getCell("A5").value = "Broker";
    ws.getCell("B5").value = "Time";
    ws.getCell("C5").value = "Rank";
    ws.getCell("D5").value = "Staff No.";
    ws.getCell("E5").value = "Tel";
    ws.getCell("F5").value = "Name";
    ws.getCell("A6").value = "K";
    ws.getCell("B6").value = "0700-1900";
    ws.getCell("C6").value = "日更保安員";
    ws.getCell("D6").value = "U91234";
    ws.getCell("E6").value = "61234567";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("G6").value = "D";
    ws.getCell("H6").value = "N";
    ws.getCell("A7").value = "K";
    ws.getCell("B7").value = "1900-0700";
    ws.getCell("C7").value = "夜更保安員";
    ws.getCell("D7").value = "U91235";
    ws.getCell("E7").value = "61234568";
    ws.getCell("F7").value = "測試安員乙";
    ws.getCell("I7").value = "N";

    const result = await parseRosterWorkbook(await toBuffer(wb), "standard.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layoutKey).toBe("standard");
    expect(result.siteRaw).toBe("測試盤A");
    expect(result.totalCellCount).toBe(3);
    expect(result.shiftCount).toBe(3);
    expect(result.dateRange).toEqual({ min: "2026-08-01", max: "2026-08-03" });
    const first = result.rows.find((r) => r.nameRaw === "測試安員甲" && r.workDate === "2026-08-01");
    expect(first?.rawCode).toBe("D");
    expect(first?.staffNoRaw).toBe("U91234");
    expect(first?.telRaw).toBe("61234567");
    expect(first?.brokerCodeRaw).toBe("K");
    expect(first?.rankRaw).toBe("日更保安員");
    expect(first?.timeRaw).toBe("0700-1900");
  });

  it("未知代號 → unknown，帶警告；leave/ot 代號正確分類", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤B";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("H4").value = aug(2);
    ws.getCell("I4").value = aug(3);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("G6").value = "AL"; // leave
    ws.getCell("H6").value = "OT1"; // ot
    ws.getCell("I6").value = "ZZ"; // unknown

    const result = await parseRosterWorkbook(await toBuffer(wb), "unknown.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byDate = new Map(result.rows.map((r) => [r.workDate, r]));
    expect(byDate.get("2026-08-01")?.codeKind).toBe("leave");
    expect(byDate.get("2026-08-02")?.codeKind).toBe("ot");
    expect(byDate.get("2026-08-02")?.hours).toBe(1);
    expect(byDate.get("2026-08-03")?.codeKind).toBe("unknown");
    expect(byDate.get("2026-08-03")?.warnings.length).toBeGreaterThan(0);
  });

  it("patch 3：M（中更）同 OT<小數> 代號", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤C";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("H4").value = aug(2);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("G6").value = "M";
    ws.getCell("H6").value = "OT3.5";

    const result = await parseRosterWorkbook(await toBuffer(wb), "m-ot.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byDate = new Map(result.rows.map((r) => [r.workDate, r]));
    expect(byDate.get("2026-08-01")?.codeKind).toBe("shift");
    expect(byDate.get("2026-08-02")?.codeKind).toBe("ot");
    expect(byDate.get("2026-08-02")?.hours).toBe(3.5);
  });

  it("Total/所需人手/尚欠 統計行成行跳過，唔當安員行", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤D";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("G6").value = "D";
    ws.getCell("F7").value = "Total";
    ws.getCell("G7").value = 1;
    ws.getCell("F8").value = "所需人手";
    ws.getCell("G8").value = 1;
    ws.getCell("F9").value = "尚欠";
    ws.getCell("G9").value = 0;

    const result = await parseRosterWorkbook(await toBuffer(wb), "stat-rows.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalCellCount).toBe(1);
    expect(result.rows[0]!.nameRaw).toBe("測試安員甲");
  });

  it("patch 6：冇雞頭碼欄（Name 喺欄位令 broker offset < 1）唔准 abort", async () => {
    // Name 喺 B 欄 → standard broker offset -5 令欄號 = -3（<1），要跳過
    // 唔可以讀 column index < 1。
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A1").value = "測試盤E"; // patch 7：A1 fallback（A2 淨係日期）
    ws.getCell("B4").value = "Date";
    ws.getCell("C4").value = aug(1);
    ws.getCell("D4").value = aug(2);
    ws.getCell("A5").value = "Time";
    ws.getCell("B5").value = "Name";
    ws.getCell("B6").value = "測試安員甲";
    ws.getCell("A6").value = "0700-1900";
    ws.getCell("C6").value = "D";

    const result = await parseRosterWorkbook(await toBuffer(wb), "no-broker.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.siteRaw).toBe("測試盤E");
    expect(result.layoutKey).toContain("no-broker-col");
    expect(result.rows[0]!.brokerCodeRaw).toBeNull();
    expect(result.rows[0]!.rawCode).toBe("D");
  });

  it("patch 7：盤名 fallback 去 A1，跳過年/月/保安值勤表等表頭字", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A1").value = 2026;
    ws.getCell("B1").value = "年";
    ws.getCell("C1").value = "8";
    ws.getCell("D1").value = "月";
    ws.getCell("E1").value = "保安值勤表";
    ws.getCell("F1").value = "真盤名F1";
    ws.getCell("F2").value = aug(1); // A2 row 淨係一個日期格，冇文字（patch 7 嘅場景）
    ws.getCell("F5").value = "Date";
    ws.getCell("G5").value = aug(1);
    ws.getCell("F6").value = "Name";
    ws.getCell("F7").value = "測試安員甲";
    ws.getCell("G7").value = "D";

    const result = await parseRosterWorkbook(await toBuffer(wb), "a1-fallback.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.siteRaw).toBe("真盤名F1");
  });
});

describe("roster-upload parse：digital_port layout", () => {
  it("Tel 同 Name 之間夾多一欄 name_en", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("C2").value = "測試盤F"; // patch2：C2 都出現過
    ws.getCell("G4").value = "Date";
    ws.getCell("H4").value = aug(1);
    ws.getCell("A5").value = "Broker";
    ws.getCell("B5").value = "Time";
    ws.getCell("C5").value = "Rank";
    ws.getCell("D5").value = "Staff No.";
    ws.getCell("E5").value = "Tel";
    // F5（label_col-1）刻意留空——digital_port 判斷準則
    ws.getCell("G5").value = "Name";
    ws.getCell("A6").value = "W";
    ws.getCell("B6").value = "0800-2000";
    ws.getCell("C6").value = "早更保安員";
    ws.getCell("D6").value = "U91236";
    ws.getCell("E6").value = "61234569";
    ws.getCell("F6").value = "Sample Guard One"; // name_en
    ws.getCell("G6").value = "測試安員丙";
    ws.getCell("H6").value = "IC";

    const result = await parseRosterWorkbook(await toBuffer(wb), "digital-port.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layoutKey).toBe("digital_port");
    expect(result.siteRaw).toBe("測試盤F");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.rawCode).toBe("IC");
    expect(result.rows[0]!.nameRaw).toBe("測試安員丙");
  });
});

describe("roster-upload parse：citybus layout（一檔多子盤）", () => {
  it("Property Name 表頭 → citybus，sub_site 逐行讀出", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "城巴車廠測試";
    ws.getCell("G4").value = "Date";
    ws.getCell("H4").value = aug(1);
    ws.getCell("A5").value = "Broker";
    ws.getCell("B5").value = "Time";
    ws.getCell("C5").value = "Rank";
    ws.getCell("D5").value = "Property Name"; // citybus marker
    ws.getCell("E5").value = "Staff No.";
    ws.getCell("F5").value = "Tel";
    ws.getCell("G5").value = "Name";
    ws.getCell("A6").value = "K";
    ws.getCell("B6").value = "0700-1900";
    ws.getCell("C6").value = "日更保安員";
    ws.getCell("D6").value = "測試車廠甲";
    ws.getCell("E6").value = "U91237";
    ws.getCell("F6").value = "61234570";
    ws.getCell("G6").value = "測試安員甲";
    ws.getCell("H6").value = "D";
    ws.getCell("A7").value = "K";
    ws.getCell("D7").value = "測試車廠乙";
    ws.getCell("E7").value = "U91238";
    ws.getCell("G7").value = "測試安員乙";
    ws.getCell("H7").value = "N";

    const result = await parseRosterWorkbook(await toBuffer(wb), "citybus.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layoutKey).toContain("citybus");
    expect(result.layoutKey).toContain("multi-subsite");
    expect(new Set(result.subSiteNames)).toEqual(new Set(["測試車廠甲", "測試車廠乙"]));
    expect(result.rows.find((r) => r.subSiteName === "測試車廠甲")?.rawCode).toBe("D");
    expect(result.rows.find((r) => r.subSiteName === "測試車廠乙")?.rawCode).toBe("N");
  });
});

describe("roster-upload parse：patch 1（日期表頭 gap）／patch 5（工作表名）", () => {
  it("patch 1：Date 表頭同第一個日期之間多一欄（例如「日薪」）", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤G";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = "日薪"; // 額外一欄
    ws.getCell("H4").value = aug(1);
    ws.getCell("I4").value = aug(2);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("H6").value = "D";
    ws.getCell("I6").value = "N";

    const result = await parseRosterWorkbook(await toBuffer(wb), "date-gap.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layoutKey).toContain("date-gap:1");
    expect(result.totalCellCount).toBe(2);
    expect(result.dateRange).toEqual({ min: "2026-08-01", max: "2026-08-02" });
  });

  it("patch 5：工作表名 2026.08 都要當可見更表分頁", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026.08");
    ws.getCell("A2").value = "測試盤H";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("G6").value = "D";

    const result = await parseRosterWorkbook(await toBuffer(wb), "sheet-name.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets[0]!.sheetName).toBe("2026.08");
    expect(result.totalCellCount).toBe(1);
  });

  it("隱藏分頁／唔啱名嘅分頁一律跳過，唔算入輸出", async () => {
    const wb = new ExcelJS.Workbook();
    const hidden = wb.addWorksheet("工作表1", { state: "hidden" });
    hidden.getCell("A2").value = "唔應該讀到";
    const photo = wb.addWorksheet("相");
    photo.getCell("A1").value = "相片";
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤I";
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("F5").value = "Name";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("D6").value = "U91234";
    ws.getCell("G6").value = "D";

    const result = await parseRosterWorkbook(await toBuffer(wb), "hidden-skip.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets).toHaveLength(1);
    expect(result.skippedSheets.map((s) => s.name).sort()).toEqual(["工作表1", "相"]);
    expect(result.siteRaw).toBe("測試盤I");
  });
});

describe("roster-upload parse：壞檔／搵唔到表頭", () => {
  it("完全冇 Date 表頭 → parse 失敗，帶原因", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = "測試盤J";
    ws.getCell("A5").value = "呢個 sheet 冇 Date 表頭";

    const result = await parseRosterWorkbook(await toBuffer(wb), "no-header.xlsx");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  it("完全冇「2026」或「2026.<月>」嘅可見分頁 → parse 失敗", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("其他分頁");
    ws.getCell("A2").value = "測試盤K";

    const result = await parseRosterWorkbook(await toBuffer(wb), "wrong-sheet.xlsx");
    expect(result.ok).toBe(false);
  });
});

// Opus 驗收（2026-09-23）補測：
describe("roster-upload parse：驗收補測", () => {
  function baseSheet(ws: ExcelJS.Worksheet, dates: Date[]) {
    ws.getCell("A2").value = "測試盤L";
    ws.getCell("F4").value = "Date";
    dates.forEach((d, i) => (ws.getRow(4).getCell(7 + i).value = d));
    ws.getRow(5).values = ["Broker", "Time", "Rank", "Staff No.", "Tel", "Name"];
    ws.getRow(6).values = ["K", "0700-1900", "Guard", "U91234", "61234567", "測試安員甲"];
  }

  // Phase B-0（老闆 2026-09-23 答）：橫向合併跨 N 個日期欄＝嗰 N 日每日一
  // 格同一個代號（3 格合併 D＝3 更、AL＝3 日年假），逐格出警告。
  it("合併儲存格：D 橫跨 3 日 → 展開做 3 格 D，每格帶「由合併格展開」警告", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    baseSheet(ws, [aug(1), aug(2), aug(3)]);
    ws.getCell("G6").value = "D";
    ws.mergeCells("G6:I6");
    const result = await parseRosterWorkbook(await toBuffer(wb), "merged-d.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalCellCount).toBe(3);
    expect(result.shiftCount).toBe(3);
    expect(result.dateRange).toEqual({ min: "2026-08-01", max: "2026-08-03" });
    for (const day of [1, 2, 3]) {
      const row = result.rows.find((r) => r.workDate === `2026-08-0${day}`);
      expect(row?.rawCode).toBe("D");
      expect(row?.warnings.some((w) => w.includes("由合併格展開") && w.includes(`第 ${day}/3 日`))).toBe(true);
    }
  });

  it("合併儲存格：AL 橫跨 2 日 → 展開做 2 格 AL（leave），每格帶警告", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    baseSheet(ws, [aug(1), aug(2)]);
    ws.getCell("G6").value = "AL";
    ws.mergeCells("G6:H6");
    const result = await parseRosterWorkbook(await toBuffer(wb), "merged-al.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalCellCount).toBe(2);
    expect(result.shiftCount).toBe(0); // leave 唔計入 shiftCount
    expect(result.codeKindBreakdown.leave).toBe(2);
    const row1 = result.rows.find((r) => r.workDate === "2026-08-01");
    const row2 = result.rows.find((r) => r.workDate === "2026-08-02");
    expect(row1?.rawCode).toBe("AL");
    expect(row2?.rawCode).toBe("AL");
    expect(row1?.warnings.some((w) => w.includes("第 1/2 日"))).toBe(true);
    expect(row2?.warnings.some((w) => w.includes("第 2/2 日"))).toBe(true);
  });

  it("合併儲存格橫跨但延伸到日期欄範圍以外（例如備註欄）→ 淨係展開日期欄部分＋另加警告", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    baseSheet(ws, [aug(1), aug(2)]); // dateEndCol = H（col 8），I（col 9）係日期範圍以外
    ws.getCell("G6").value = "D";
    ws.mergeCells("G6:I6"); // 合併範圍伸出咗去 I（備註欄），冇日期
    const result = await parseRosterWorkbook(await toBuffer(wb), "merged-beyond.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 淨係展開咗日期欄部分（G,H＝2 格），I 唔屬於日期欄，唔會生成第三格。
    expect(result.totalCellCount).toBe(2);
    expect(result.dateRange).toEqual({ min: "2026-08-01", max: "2026-08-02" });
    expect(result.warnings.some((w) => w.includes("延伸到日期欄範圍以外"))).toBe(true);
  });

  it("合併儲存格：姓名直跨兩行，第二行當冇姓名（唔會靜靜借用上一行個名）", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    baseSheet(ws, [aug(1), aug(2)]);
    ws.getCell("G6").value = "D";
    ws.getRow(7).values = ["K", "1900-0700", "Guard", null, null, null, "N", "N"];
    ws.mergeCells("F6:F7");
    const result = await parseRosterWorkbook(await toBuffer(wb), "merged-name.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.filter((r) => r.rowIndex === 7)).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("row 7") && w.includes("冇姓名"))).toBe(true);
  });

  it("工作表名唔寫死 2026：2027 年更表都讀到", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2027");
    baseSheet(ws, [new Date(Date.UTC(2027, 0, 1))]);
    ws.getCell("G6").value = "D";
    const result = await parseRosterWorkbook(await toBuffer(wb), "2027.xlsx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]!.workDate).toBe("2027-01-01");
  });
});
