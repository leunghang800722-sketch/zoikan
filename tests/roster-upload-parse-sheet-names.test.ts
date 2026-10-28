// HIST-2 目標 1：分頁名容許 YYYYMM／YYYY-MM／YYYY.MM；冇任何分頁名對到
// 時 fallback 用「可見、非相片／Summary 類、有 Date 表頭」嘅分頁。
// 全部合成 fixture（exceljs 生成），零 PII、零讀 data/。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseRosterWorkbook } from "@/lib/roster-upload/parse";

function d(month: number, day: number): Date {
  return new Date(Date.UTC(2026, month - 1, day));
}

function fillRoster(ws: ExcelJS.Worksheet, site: string, dates: Date[]): void {
  ws.getCell("A2").value = site;
  ws.getCell("F4").value = "Date";
  dates.forEach((dt, i) => {
    ws.getRow(4).getCell(7 + i).value = dt;
  });
  ws.getCell("F5").value = "Name";
  ws.getCell("D6").value = "U91234";
  ws.getCell("F6").value = "測試保安員甲";
  dates.forEach((_dt, i) => {
    ws.getRow(6).getCell(7 + i).value = "D";
  });
}

async function parse(wb: ExcelJS.Workbook) {
  return parseRosterWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), "synthetic.xlsx");
}

describe("roster parse：分頁名格式", () => {
  for (const name of ["202601", "2026-01", "2026.01", "2026.1", "2026"]) {
    it(`認 ${name}`, async () => {
      const wb = new ExcelJS.Workbook();
      fillRoster(wb.addWorksheet(name), "測試盤A", [d(1, 1), d(1, 2)]);
      const r = await parse(wb);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.totalCellCount).toBe(2);
      expect(r.warnings.some((w) => w.includes("fallback"))).toBe(false);
    });
  }

  it("標準分頁名存在時，其他唔符分頁照舊跳過（唔行 fallback）", async () => {
    const wb = new ExcelJS.Workbook();
    fillRoster(wb.addWorksheet("202602"), "測試盤A", [d(2, 1)]);
    fillRoster(wb.addWorksheet("Feb+Mar"), "測試盤B", [d(2, 2)]);
    const r = await parse(wb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.siteRaw).toBe("測試盤A");
    expect(r.skippedSheets.map((s) => s.name)).toEqual(["Feb+Mar"]);
  });
});

describe("roster parse：fallback 分頁", () => {
  it("202512-202601 跨月分頁名 fallback 採用，記警告", async () => {
    const wb = new ExcelJS.Workbook();
    fillRoster(wb.addWorksheet("202512-202601"), "測試活動A", [
      new Date(Date.UTC(2025, 11, 30)),
      new Date(Date.UTC(2025, 11, 31)),
      d(1, 1),
    ]);
    const r = await parse(wb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCellCount).toBe(3);
    expect(r.sheets[0]!.sheetName).toBe("202512-202601");
    expect(r.warnings.some((w) => w.includes("fallback") && w.includes("202512-202601"))).toBe(true);
  });

  it("Feb+Mar／Mar 採用；相／工作表N／Summary／隱藏／冇 Date 表頭如實記 skipped reason", async () => {
    const wb = new ExcelJS.Workbook();
    fillRoster(wb.addWorksheet("Mar"), "測試活動B", [d(3, 1), d(3, 2)]);
    wb.addWorksheet("相").getCell("A1").value = "photo";
    fillRoster(wb.addWorksheet("工作表1"), "測試舊分頁", [d(3, 5)]);
    fillRoster(wb.addWorksheet("Summary"), "測試統計", [d(3, 6)]);
    const hidden = wb.addWorksheet("Old");
    fillRoster(hidden, "測試隱藏", [d(3, 7)]);
    hidden.state = "hidden";
    wb.addWorksheet("Notes").getCell("A1").value = "備忘";
    const r = await parse(wb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheets.map((s) => s.sheetName)).toEqual(["Mar"]);
    expect(r.totalCellCount).toBe(2);
    const by = new Map(r.skippedSheets.map((s) => [s.name, s.reason]));
    expect(by.get("相")).toContain("相片");
    expect(by.get("工作表1")).toContain("預設工作表");
    expect(by.get("Summary")).toContain("Summary");
    expect(by.get("Old")).toContain("隱藏");
    expect(by.get("Notes")).toContain("Date");
  });

  it("全部分頁都無 Date 表頭 → parse_failed（ok=false）", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Mar").getCell("A1").value = "x";
    const r = await parse(wb);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skippedSheets.some((s) => s.name === "Mar")).toBe(true);
  });

  it("M2：Summary (2)／工作表1 (2)／相 (2)／Sheet1 (2)／總表2／統計 都唔當更表，格數唔重複計", async () => {
    const wb = new ExcelJS.Workbook();
    fillRoster(wb.addWorksheet("Mar"), "測試活動B", [d(3, 1), d(3, 2)]);
    for (const n of ["Summary (2)", "工作表1 (2)", "相 (2)", "Sheet1 (2)", "總表2", "統計"]) fillRoster(wb.addWorksheet(n), "測試複製", [d(3, 1), d(3, 2)]);
    const r = await parse(wb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCellCount).toBe(2);
    expect(r.sheets.map((s) => s.sheetName)).toEqual(["Mar"]);
    expect(r.skippedSheets).toHaveLength(6);
  });

  it("M2：多個唔符標準名而有 Date 表頭嘅分頁 → 只採用格數最多嗰個，其餘 skipped＋needs-review 警告", async () => {
    const wb = new ExcelJS.Workbook();
    fillRoster(wb.addWorksheet("Feb"), "測試活動C", [d(2, 1)]);
    fillRoster(wb.addWorksheet("Feb+Mar"), "測試活動C", [d(2, 1), d(2, 2), d(3, 1)]);
    const r = await parse(wb);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalCellCount).toBe(3);
    expect(r.sheets.map((s) => s.sheetName)).toEqual(["Feb+Mar"]);
    expect(r.skippedSheets.map((s) => s.name)).toEqual(["Feb"]);
    expect(r.warnings.some((w) => w.includes("只採用"))).toBe(true);
  });

  async function parseM(wb: ExcelJS.Workbook, month?: Date) {
    return parseRosterWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), "synthetic.xlsx", month ? { uploadMonth: month } : {});
  }
  function fillPeople(ws: ExcelJS.Worksheet, dates: Date[], people: number): void {
    fillRoster(ws, "測試活動D", dates);
    for (let i = 1; i < people; i++) {
      ws.getCell(`D${6 + i}`).value = `U9123${i}`;
      ws.getCell(`F${6 + i}`).value = `測試保安員${i}`;
      dates.forEach((_x, j) => (ws.getRow(6 + i).getCell(7 + j).value = "D"));
    }
  }

  it("S1：「Mar」(1 人)＋「Total」(3 人，表頭落 4 月) 以 3 月上載 → 揀 Mar；唔傳 uploadMonth 照舊睇格數（揀 Total）", async () => {
    const wb = new ExcelJS.Workbook();
    fillPeople(wb.addWorksheet("Mar"), [d(3, 1), d(3, 2)], 1);
    fillPeople(wb.addWorksheet("Total"), [d(4, 1), d(4, 2)], 3);
    const r = await parseM(wb, d(3, 1));
    expect(r.ok && r.sheets.map((s) => s.sheetName)).toEqual(["Mar"]);
    const r0 = await parseM(wb);
    expect(r0.ok && r0.sheets.map((s) => s.sheetName)).toEqual(["Total"]);
  });

  it("S1：「Feb」「Mar」兩頁以 3 月上載 → 揀 Mar；平手先睇格數", async () => {
    const wb = new ExcelJS.Workbook();
    fillPeople(wb.addWorksheet("Feb"), [d(2, 1), d(2, 2), d(2, 3)], 2);
    fillPeople(wb.addWorksheet("Mar"), [d(3, 1), d(3, 2)], 1);
    const r = await parseM(wb, d(3, 1));
    expect(r.ok && r.sheets.map((s) => s.sheetName)).toEqual(["Mar"]);
    const wb2 = new ExcelJS.Workbook();
    fillPeople(wb2.addWorksheet("A1x"), [d(3, 1), d(3, 2)], 1);
    fillPeople(wb2.addWorksheet("B1x"), [d(3, 1), d(3, 2)], 2);
    const r2 = await parseM(wb2, d(3, 1));
    expect(r2.ok && r2.sheets.map((s) => s.sheetName)).toEqual(["B1x"]);
  });
});
