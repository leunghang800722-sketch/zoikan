// HIST-2 目標 6：scripts/report/hist-roster-digest.ts（本機消化報告）純函數測試——合成 xlsx，零讀 data/。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseRosterWorkbook } from "@/lib/roster-upload/parse";
import { categorizeWarning, digestParsed, buildMonthDigest, renderMonthDigest } from "../scripts/report/hist-roster-digest";
import type { PostorderRosterRow } from "@/lib/month-close/auto/postorder-evidence";

async function build(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("202603");
  ws.getCell("A2").value = "測試消化盤";
  ws.getCell("F4").value = "Date";
  const dates = [new Date(Date.UTC(2026, 2, 1)), new Date(Date.UTC(2026, 2, 2)), new Date(Date.UTC(2026, 2, 3)), new Date(Date.UTC(2026, 3, 1))];
  dates.forEach((d, i) => (ws.getRow(4).getCell(7 + i).value = d));
  ws.getCell("F5").value = "Name";
  ws.getCell("D6").value = "U91234";
  ws.getCell("F6").value = "測試保安員甲";
  ["D", "AL", "OT2", "D"].forEach((c, i) => (ws.getRow(6).getCell(7 + i).value = c));
  ws.getCell("D7").value = "U91235";
  ws.getCell("F7").value = "測試保安員乙";
  ["A", "測試備註人名", "D", ""].forEach((c, i) => c && (ws.getRow(7).getCell(7 + i).value = c));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("HIST-2 本機消化報告", () => {
  it("digestParsed：本月／月份不符、更／OT／leave／unknown 分類；非短代號 unknown 只計格數", async () => {
    const res = await parseRosterWorkbook(await build(), "x.xlsx");
    const d = digestParsed(res, "2026-03", "fallback");
    expect(d.ok).toBe(true);
    expect(d.label).toBe("測試消化盤");
    expect(d.inMonthCells).toBe(6);
    expect(d.outOfMonthCells).toBe(1);
    expect(d.shiftCells).toBe(2); // D、D(3/3)
    expect(d.otCells).toBe(1);
    expect(d.leaveCells).toBe(1);
    expect(d.unknownCodes).toEqual({ A: 1 });
    expect(d.unknownOtherCells).toBe(1);
    expect(d.headerMonths).toEqual(["2026-03", "2026-04"]);
  });

  it("render 輸出冇姓名／工號／備註文字；Postorder 比對有差異列出", async () => {
    const res = await parseRosterWorkbook(await build(), "x.xlsx");
    const d = digestParsed(res, "2026-03", "fallback");
    const po: PostorderRosterRow[] = [{ rowIndex: 9, clientLabel: "測試消化盤", labelHead: "測試消化盤", propertyShort: "消化", shiftLabel: "Day", cells: 5 }];
    const md = renderMonthDigest(buildMonthDigest("2026-03", [d], po));
    expect(md).toContain("測試消化盤");
    expect(md).toContain("差 -2"); // 更表 shift＋OT = 3，Postorder 5
    for (const bad of ["測試保安員甲", "測試保安員乙", "U91234", "U91235", "測試備註人名"]) expect(md).not.toContain(bad);
  });

  it("categorizeWarning：引號內容、儲存格位置、數字抹走", () => {
    expect(categorizeWarning("[202601] row 12：格仔代號「ZZ測試」未喺對照表出現，人手覆核")).toBe("格仔代號「…」未喺對照表出現，人手覆核");
    expect(categorizeWarning("[分頁跳過] 工作表1：分頁狀態=hidden（隱藏），跳過")).toBe("工作表N：分頁狀態=hidden（隱藏），跳過");
  });

  it("解析失敗檔：列錯誤，唔拋", async () => {
    const res = await parseRosterWorkbook(Buffer.from("not an xlsx"), "bad.xlsx");
    const d = digestParsed(res, "2026-03", "壞檔盤");
    expect(d.ok).toBe(false);
    expect(d.label).toBe("壞檔盤");
    expect(renderMonthDigest(buildMonthDigest("2026-03", [d], null))).toContain("解析失敗");
  });
});
