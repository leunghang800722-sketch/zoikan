// WP-LTPAY Phase 2（§20.4）：Maxwell 長工名單解析器單元測試——合成
// workbook（唔用真實 Maxwell 檔案，唔用真名/真工號），驗證欄位對應
// （抄自 s04_longterm.py COL 位置）同配對邏輯。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseMaxwellWorkbook, parseMaxwellCsv, parseCsvDate, parseCsvNumber, matchMaxwellRows, type GuardCandidate } from "@/lib/longterm-payroll/maxwell-import";

async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheetName of ["在職名單", "離職名單"]) {
    const ws = wb.addWorksheet(sheetName);
    // 表頭（第 2 行）——留返關鍵幾欄方便「掃全行搵 MPF/離職欄」測試。
    ws.getCell(2, 2).value = "Site";
    ws.getCell(2, 3).value = "Staff No.";
    ws.getCell(2, 4).value = "Name (English)";
    ws.getCell(2, 5).value = "Name";
    ws.getCell(2, 20).value = "Probation Period (Months)";
    ws.getCell(2, 30).value = "MPF Enrollment Date";
    ws.getCell(2, 31).value = "Last Working Day";

    // 資料行（第 3 行開始）。
    ws.getCell(3, 2).value = "測試盤A";
    ws.getCell(3, 3).value = sheetName === "在職名單" ? "MG9001" : "MG9002";
    ws.getCell(3, 4).value = "TEST GUARD A";
    ws.getCell(3, 5).value = "測試長工甲";
    ws.getCell(3, 7).value = new Date("1990-01-15");
    ws.getCell(3, 8).value = 36;
    ws.getCell(3, 11).value = "91234567";
    ws.getCell(3, 14).value = "保安員";
    ws.getCell(3, 18).value = new Date("2024-03-01");
    ws.getCell(3, 20).value = "1"; // 試用期 1 個月
    ws.getCell(3, 22).value = 12;
    ws.getCell(3, 23).value = 15000;
    ws.getCell(3, 27).value = "Yes";
    ws.getCell(3, 29).value = 7;
    ws.getCell(3, 30).value = new Date("2024-05-01");
    if (sheetName === "離職名單") {
      ws.getCell(3, 31).value = new Date("2026-08-20");
    }

    // 第二行：試用期「No」，方便驗證 normalizeProbation。
    ws.getCell(4, 3).value = sheetName === "在職名單" ? "MG9003" : "MG9004";
    ws.getCell(4, 5).value = "測試長工乙";
    ws.getCell(4, 20).value = "No";
    ws.getCell(4, 23).value = 16000;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseMaxwellWorkbook", () => {
  it("解析在職／離職兩個分頁，欄位對應正確", async () => {
    const buf = await buildWorkbook();
    const { rows, warnings } = await parseMaxwellWorkbook(buf);
    expect(warnings).toEqual([]);
    expect(rows.length).toBe(4); // 2 分頁 × 2 行

    const active1 = rows.find((r) => r.staffNo === "MG9001")!;
    expect(active1.status).toBe("active");
    expect(active1.name).toBe("測試長工甲");
    expect(active1.nameEn).toBe("TEST GUARD A");
    expect(active1.site).toBe("測試盤A");
    expect(active1.dob).toBe("1990-01-15");
    expect(active1.age).toBe(36);
    expect(active1.tel).toBe("91234567");
    expect(active1.position).toBe("保安員");
    expect(active1.commencement).toBe("2024-03-01");
    expect(active1.probationMonths).toBe(1);
    expect(active1.workingHour).toBe(12);
    expect(active1.basic).toBe(15000);
    expect(active1.restDay).toBe("Yes");
    expect(active1.annualLeave).toBe(7);
    expect(active1.mpfEnroll).toBe("2024-05-01");
  });

  it("Probation 'No' 正規化做 null", async () => {
    const buf = await buildWorkbook();
    const { rows } = await parseMaxwellWorkbook(buf);
    const row2 = rows.find((r) => r.staffNo === "MG9003")!;
    expect(row2.probationMonths).toBeNull();
  });

  it("離職名單掃到「Last Working Day」做 lastDay", async () => {
    const buf = await buildWorkbook();
    const { rows } = await parseMaxwellWorkbook(buf);
    const left1 = rows.find((r) => r.staffNo === "MG9002")!;
    expect(left1.status).toBe("left");
    expect(left1.lastDay).toBe("2026-08-20");
  });

  it("空行唔會出現喺結果", async () => {
    const buf = await buildWorkbook();
    const { rows } = await parseMaxwellWorkbook(buf);
    expect(rows.every((r) => r.staffNo || r.name)).toBe(true);
  });

  it("搵唔到分頁就出 warning，唔會 throw", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("亂咁改個名");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { rows, warnings } = await parseMaxwellWorkbook(buf);
    expect(rows).toEqual([]);
    expect(warnings.some((w) => w.includes("在職名單"))).toBe(true);
    expect(warnings.some((w) => w.includes("離職名單"))).toBe(true);
  });
});

describe("matchMaxwellRows", () => {
  const candidates: GuardCandidate[] = [
    { guardId: "g1", nameZh: "測試長工甲", staffNoMw: "MG9001", staffNo: null },
    { guardId: "g2", nameZh: "測試長工乙", staffNoMw: null, staffNo: null },
    { guardId: "g3", nameZh: "撞名保安員", staffNoMw: null, staffNo: null },
    { guardId: "g4", nameZh: "撞名保安員", staffNoMw: null, staffNo: null },
  ];

  it("MG 員工編號完全一致 → matched_staff_no", async () => {
    const buf = await buildWorkbook();
    const { rows } = await parseMaxwellWorkbook(buf);
    const row = rows.find((r) => r.staffNo === "MG9001")!;
    const [result] = matchMaxwellRows([row], candidates);
    expect(result.status).toBe("matched_staff_no");
    expect(result.guardId).toBe("g1");
  });

  it("冇 staff_no 命中，跟中文姓名唯一命中 → matched_name", () => {
    const row = { staffNo: null, name: "測試長工乙" } as unknown as Parameters<typeof matchMaxwellRows>[0][number];
    const [result] = matchMaxwellRows([row], candidates);
    expect(result.status).toBe("matched_name");
    expect(result.guardId).toBe("g2");
  });

  it("撞名（多過一個候選）→ unmatched，唔會亂咁揀一個", () => {
    const row = { staffNo: null, name: "撞名保安員" } as unknown as Parameters<typeof matchMaxwellRows>[0][number];
    const [result] = matchMaxwellRows([row], candidates);
    expect(result.status).toBe("unmatched");
    expect(result.guardId).toBeNull();
  });

  it("完全對唔到 → unmatched", () => {
    const row = { staffNo: "MG0000", name: "完全冇呢個人" } as unknown as Parameters<typeof matchMaxwellRows>[0][number];
    const [result] = matchMaxwellRows([row], candidates);
    expect(result.status).toBe("unmatched");
  });
});

// Opus 5.5 驗收（2026-09-27）：CSV 路徑——正式站操作員淨係可以傳 CSV。
// 同一份合成 workbook 逐格砌返「Excel 另存 CSV」嘅顯示文字（日期按範本
// d/m/yyyy、金額 `$#,##0`），驗 parseMaxwellCsv() 同 parseMaxwellWorkbook()
// 結果一模一樣；另外驗真 Maxwell 檔嗰種 data validation 唔會令 xlsx 路徑 500。
function toCsvCell(v: ExcelJS.CellValue, style: "dmy" | "mdy" | "mmm" | "iso"): string {
  if (v instanceof Date) {
    const d = v.getUTCDate();
    const m = v.getUTCMonth() + 1;
    const y = v.getUTCFullYear();
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
    if (style === "mdy") return `${m}/${d}/${y}`;
    if (style === "mmm") return `${String(d).padStart(2, "0")}-${mon}-${y}`;
    if (style === "iso") return v.toISOString().slice(0, 10);
    return `${d}/${m}/${y}`;
  }
  if (typeof v === "number") return v >= 1000 ? `"$${v.toLocaleString("en-US")}"` : String(v);
  return v == null ? "" : String(v);
}

async function workbookToCsvFiles(buf: Buffer, style: "dmy" | "mdy" | "mmm" | "iso") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return (["在職名單", "離職名單"] as const).map((name, i) => {
    const ws = wb.getWorksheet(name)!;
    const lines: string[] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const cells: string[] = [];
      for (let c = 1; c <= 32; c++) cells.push(toCsvCell(ws.getRow(r).getCell(c).value, style));
      lines.push(cells.join(","));
    }
    return { status: i === 0 ? ("active" as const) : ("left" as const), text: "﻿" + lines.join("\r\n") };
  });
}

describe("parseMaxwellCsv（CSV 路徑）", () => {
  for (const style of ["dmy", "mdy", "mmm", "iso"] as const) {
    it(`在職／離職兩個 CSV（日期 ${style}）同 xlsx 解析結果一模一樣`, async () => {
      const buf = await buildWorkbook();
      const fromXlsx = await parseMaxwellWorkbook(buf);
      const fromCsv = parseMaxwellCsv(await workbookToCsvFiles(buf, style));
      expect(fromCsv.rows).toEqual(fromXlsx.rows);
    });
  }

  it("parseCsvDate：d/m 同 m/d 由成個檔決定；非法日期回 null", () => {
    expect(parseCsvDate("13/8/2026", "dmy")).toBe("2026-08-13");
    expect(parseCsvDate("8/13/2026", "mdy")).toBe("2026-08-13");
    expect(parseCsvDate("01-Aug-2026", "dmy")).toBe("2026-08-01");
    expect(parseCsvDate("2026-08-01", "mdy")).toBe("2026-08-01");
    expect(parseCsvDate("31/2/2026", "dmy")).toBeNull();
    expect(parseCsvDate("abc", "dmy")).toBeNull();
  });

  it("parseCsvNumber：$、千位逗號、括號負數", () => {
    expect(parseCsvNumber("$15,000")).toBe(15000);
    expect(parseCsvNumber("15,000.50")).toBe(15000.5);
    expect(parseCsvNumber("(100)")).toBe(-100);
    expect(parseCsvNumber("No")).toBeNull();
  });

  it("日期兩段都 ≤12、分唔到日/月——按 d/m 讀並出 warning", () => {
    const header = Array.from({ length: 30 }, () => "").join(",");
    const row = Array.from({ length: 30 }, (_, i) => (i === 2 ? "MG9101" : i === 4 ? "測試長工丙" : i === 17 ? "3/4/2024" : i === 22 ? "15000" : "")).join(",");
    const { rows, warnings } = parseMaxwellCsv([{ status: "active", text: `title\n${header}\n${row}` }]);
    expect(rows[0].commencement).toBe("2024-04-03");
    expect(warnings.some((w) => w.includes("分唔到日/月"))).toBe(true);
  });
});

describe("parseMaxwellWorkbook：真檔案式 data validation", () => {
  it("有覆蓋整欄嘅下拉選單 validation 都唔會 throw（原本 ExcelJS 拋 RangeError）", async () => {
    const buf = await buildWorkbook();
    const zip = await JSZip.loadAsync(buf);
    const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))!;
    const xml = await zip.file(sheetName)!.async("string");
    const dv = '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="AA3:AA1048576 AB3:AB1048576 T3:T1048576"><formula1>"Yes,No"</formula1></dataValidation></dataValidations>';
    zip.file(sheetName, xml.replace("</sheetData>", "</sheetData>" + dv));
    const withDv = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const { rows } = await parseMaxwellWorkbook(withDv);
    expect(rows.length).toBe(4);
  });
});
