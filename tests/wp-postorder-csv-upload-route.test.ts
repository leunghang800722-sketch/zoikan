// WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：`POST /api/guard-fix/postorder`
// integration test——兩個 CSV（roster_csv + postorder_csv）上載路徑同
// 原有 xlsm 上載路徑，對住**同一份合成 workbook** 應該解析出一致嘅
// `parseSummary`（長工格數／組合數／介紹費行數／介紹費 excelAmount 合計
// 一致），同埋 `postorder_uploads` 表存低嘅 bytes 欄位分工正確。
//
// 鐵則：合成 fixture 用假人名（跟現有 wp-guard-fix-ui.test.ts 一致風格）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listPostorder, POST as uploadPostorder } from "@/app/api/guard-fix/postorder/route";

function reqJson(url: string, cookie: string, method = "GET"): Request {
  return new Request(url, { method, headers: { cookie } });
}

function reqMultipartXlsm(url: string, cookie: string, buffer: Buffer, month: string, fileName = "postorder.xlsm"): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

function reqMultipartCsv(url: string, cookie: string, rosterCsv: string | null, postorderCsv: string | null, month: string): Request {
  const form = new FormData();
  if (rosterCsv !== null) form.set("roster_csv", new File([rosterCsv], "Roster.csv", { type: "text/csv" }));
  if (postorderCsv !== null) form.set("postorder_csv", new File([postorderCsv], "PostOrder.csv", { type: "text/csv" }));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

// --- 模擬 Google Sheets「下載為 CSV」：逐格讀值 stringify（同
// tests/wp-postorder-csv-grid-parse.test.ts 一致手法，呢度自成一份
// 方便呢個 test 檔獨立跑）。---
function cellPlainValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in (v as Record<string, unknown>)) {
      return (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? "").join("");
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("result" in (v as Record<string, unknown>)) return cellPlainValue((v as { result: unknown }).result);
    return "";
  }
  return String(v);
}
function csvEscape(s: string): string {
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function worksheetToSimulatedCsv(ws: ExcelJS.Worksheet, maxCol: number): string {
  const lines: string[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= maxCol; c++) cells.push(csvEscape(cellPlainValue(row.getCell(c).value)));
    lines.push(cells.join(","));
  }
  return lines.join("\r\n");
}

/** 合成一個帶 Roster＋PostOrder 兩個 sheet 嘅 workbook——同
 * tests/wp-ltshift-postorder-parse.test.ts 一致嘅 fixture 排位。 */
async function buildPostorderWorkbook(): Promise<{ wb: ExcelJS.Workbook; buffer: Buffer }> {
  const wb = new ExcelJS.Workbook();
  const roster = wb.addWorksheet("Roster");
  // WP-POSTORDER-ROBUST：表頭要帶齊「雞頭名」／「備註」逐日子欄字眼——
  // 解析器由呢啲字眼自己搵欄位置，唔再靠寫死 col 9/10/16/17。
  roster.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "1-8月", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "2-8月", "雞頭名", "備註"];
  roster.getCell("A9").value = "測試盤 甲蟲蟲";
  roster.getCell("C9").value = "測試";
  roster.getCell("I9").value = "(8) 長工";
  roster.getCell("J9").value = "甲蟲蟲";
  roster.getCell("P9").value = "(8) 長工";
  roster.getCell("Q9").value = "甲蟲蟲";
  roster.getCell("A10").value = "另一盤 乙屎蟲";
  roster.getCell("C10").value = "另一";
  roster.getCell("I10").value = "(8) 長工";
  roster.getCell("J10").value = "乙屎蟲";

  const po = wb.addWorksheet("PostOrder");
  po.getRow(7).values = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間"];
  po.getCell("A8").value = "測試盤 甲蟲蟲";
  po.getCell("C8").value = "測試";
  po.getCell(8, 39).value = 20;
  po.getCell("A9").value = "測試盤 丙金蟲";
  po.getCell("C9").value = "測試";
  po.getCell(9, 39).value = 5;
  po.getCell("A10").value = "長工雞頭費 (淦)";
  po.getCell("C10").value = "淦";
  po.getCell("F10").value = { formula: "50*SUM(AM8,AM9)", result: 1250 };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { wb, buffer };
}

interface PostorderUploadDTO {
  id: string;
  parse_summary: {
    longterm_site_count: number;
    longterm_post_pair_count: number;
    longterm_cell_count: number;
    referral_row_count: number;
    referral_total_excel_amount: number;
    missing_sheets: string[];
    roster_header_row: number | null;
    roster_day_block_width: number | null;
    roster_first_day_col: number | null;
    parse_error: string | null;
    // WP-POSTORDER-PO-PAIRS（老闆 2026-09-27 再緊急）：CSV 路徑有
    // `postorderCsvText`，上載嗰刻順手計「單靠 PostOrder 推到幾多個
    // (盤,人) 組合」提示——xlsm 路徑冇獨立 CSV 原文，呢兩個欄一律唔存在
    // （已知差異，見底下 §3 test）。
    longterm_pairs_from_postorder?: number;
    longterm_cells_from_postorder?: number;
  } | null;
}

describe("WP-POSTORDER-CSV：POST /api/guard-fix/postorder CSV 路徑", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
  });

  it("§1 主管上載 CSV → 403（安員配對修復淨係老闆）", async () => {
    const res = await uploadPostorder(reqMultipartCsv("http://test.local/api/guard-fix/postorder", supervisorCookie, "a,b\n1,2", "a,b\n1,2", "2026-08-01"));
    expect(res.status).toBe(403);
  });

  it("§2 淨係帶其中一個 CSV → 400", async () => {
    const res = await uploadPostorder(reqMultipartCsv("http://test.local/api/guard-fix/postorder", ownerCookie, "a,b\n1,2", null, "2026-08-01"));
    expect(res.status).toBe(400);
  });

  it("§3 兩個 CSV 上載嘅 parse_summary 同 xlsm 上載一致（除咗 rate 冇公式、同 WP-POSTORDER-PO-PAIRS 新加嘅 longterm_pairs_from_postorder／longterm_cells_from_postorder 兩個已知差異，唔影響其他 summary 欄）", async () => {
    const { wb, buffer } = await buildPostorderWorkbook();

    const xlsmRes = await uploadPostorder(reqMultipartXlsm("http://test.local/api/guard-fix/postorder", ownerCookie, buffer, "2026-08-01"));
    expect(xlsmRes.status).toBe(201);
    const xlsmBody = (await xlsmRes.json()) as { upload: PostorderUploadDTO };

    const rosterCsv = worksheetToSimulatedCsv(wb.getWorksheet("Roster")!, 240);
    const postorderCsv = worksheetToSimulatedCsv(wb.getWorksheet("PostOrder")!, 60);
    const csvRes = await uploadPostorder(reqMultipartCsv("http://test.local/api/guard-fix/postorder", ownerCookie, rosterCsv, postorderCsv, "2026-08-01"));
    expect(csvRes.status).toBe(201);
    const csvBody = (await csvRes.json()) as { upload: PostorderUploadDTO };

    expect(csvBody.upload.parse_summary?.parse_error).toBeNull();
    // WP-POSTORDER-PO-PAIRS：CSV 路徑有獨立 PostOrder CSV 原文，會多出
    // `longterm_pairs_from_postorder`／`longterm_cells_from_postorder`
    // 呢兩個欄（xlsm 路徑冇——見上面 PostorderUploadDTO 註解），去咗先比
    // 其餘欄一致。
    const { longterm_pairs_from_postorder: _p, longterm_cells_from_postorder: _c, ...csvSummaryRest } = csvBody.upload.parse_summary ?? {};
    expect(csvSummaryRest).toEqual(xlsmBody.upload.parse_summary);

    // 兩個 CSV bytes 各自存低，fileBytes 都有值（佔位，NOT NULL）。
    const row = await prisma.postorderUpload.findUnique({ where: { id: csvBody.upload.id } });
    expect(row?.rosterCsvBytes).toBeTruthy();
    expect(row?.postorderCsvBytes).toBeTruthy();
    expect(row?.fileBytes.length).toBeGreaterThan(0);

    // CSV 上載係「呢個月現用」最新一份（GET 返嘅 current）。
    const getRes = await listPostorder(reqJson("http://test.local/api/guard-fix/postorder?month=2026-08-01", ownerCookie));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { current: PostorderUploadDTO | null };
    expect(getBody.current?.id).toBe(csvBody.upload.id);
  });

  it("§4 CSV 路徑冇 Roster／PostOrder sheet 對應嘅內容都照計（空 CSV 一行 header）——missingSheets 唔會觸發（有帶兩個檔），但長工格／介紹費行 0", async () => {
    const emptyCsv = "客戶名稱,Customer Code,物業名稱\r\n";
    const res = await uploadPostorder(reqMultipartCsv("http://test.local/api/guard-fix/postorder", ownerCookie, emptyCsv, emptyCsv, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO };
    expect(body.upload.parse_summary?.missing_sheets).toEqual([]);
    expect(body.upload.parse_summary?.longterm_cell_count).toBe(0);
    expect(body.upload.parse_summary?.referral_row_count).toBe(0);
  });
});
