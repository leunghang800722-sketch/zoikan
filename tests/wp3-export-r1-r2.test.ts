// Opus 對抗式驗收第二輪 R1／R2：
// R1 ── `guardsByRowRange()`（`src/lib/roster-export.ts`）遇到「成行
// 曾經有 shift_record，但而家全部 status=cancelled」嗰種 row，之前會
// 跌落 `section.rawRows`（seed 時捕捉、void 之前嘅原檔字面）——即係話
// 一格 void 咗嘅更，匯出重新出返嗰個 block 竟然照樣印返 void 之前嘅
// 內容。修法：`guardsByRowRange()` 依然喺 `byRow` set 一個 entry（零
// 逐日格，行首欄由呢條 cancelled 記錄嘅 guard 推導），唔准再跌落
// `section.rawRows`。
// R2 ── `RosterExportResult.rawFallbackCells` 加第三類 `allCancelled`
// ——呢一類行雖然係純 DB 推導（唔係 raw 字面），但內容已經同原檔（seed
// 嗰個月）唔一致，值得單獨計落「覆蓋率」個分母，等報表反映呢個變化。
//
// 用 wp2-fixture 嘅假資料（起自己一個 roster_layout 模板，唔碰真實
// 7 月 import 數據——PDPO）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildRosterWorkbookForSite } from "../src/lib/roster-export";
import { POST as voidShiftRecord } from "@/app/api/shift-records/[id]/void/route";
import type ExcelJSNS from "exceljs";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const RAW_MARKER = "FAKE-VOID-BEFORE-RAW-MARKER-唔應該出現";
const ROW = 5;

function scanSheet(ws: ExcelJSNS.Worksheet): string[] {
  const values: string[] = [];
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value === null || cell.value === undefined || cell.value === "") return;
      values.push(String(cell.value));
    });
  });
  return values;
}

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("Opus 對抗式驗收第二輪 R1／R2：成行 void 晒唔准跌返 section.rawRows", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let recordId: string;

  beforeEach(async () => {
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    // 起一個最簡單嘅 roster_layout 模板：一個 guard_rows section（row
    // 5~5），`rawRows["5"]` 模擬 seed 時捕捉嘅「void 之前」原檔字面
    // （帶一個獨特 marker，方便斷言「有冇漏咗跌落呢個 fallback」）。
    await prisma.site.update({
      where: { id: fx.site.id },
      data: {
        rosterLayout: {
          layout: "standard",
          sections: [
            {
              kind: "guard_rows",
              rowFrom: ROW,
              rowTo: ROW,
              shiftTypeCodes: [fx.shiftType.id],
              minRows: 1,
              hasTrailingTotal: false,
              rawRows: { [String(ROW)]: { "6": RAW_MARKER } },
            },
          ],
        },
      },
    });

    // 重用 fixture 現成嘅 shiftRecordA（siteId/shiftTypeId/guardId/
    // workDate 已經同呢個模板嘅 section 對得上——fx.unlockedMonth=
    // day1），淨係幫佢補一個 `provenance.cell` 令 `provenanceRowNumber()`
    // 搵到 ROW（唔另外 create，避免撞 fixture 本身已經有嘅 (guard_id,
    // work_date, shift_type_id) unique）。
    const record = await prisma.shiftRecord.update({
      where: { id: fx.shiftRecordA.id },
      data: { provenance: { cell: `G${ROW}` } }, // provenanceRowNumber() 淨係睇數字部分，col 字母唔緊要
    });
    recordId = record.id;
  });

  it("void 之前：呢一行正常出（唔靠 raw fallback，guard 身份出到、有逐日格）；rawFallbackCells.allCancelled=0", async () => {
    const before = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const wsBefore = before.workbook.getWorksheet("2026")!;
    const valuesBefore = scanSheet(wsBefore);
    expect(valuesBefore.some((v) => v.includes("測試安員甲"))).toBe(true);
    expect(valuesBefore.includes(RAW_MARKER)).toBe(false); // 有 active 記錄，唔應該用 section.rawRows
    expect(before.rawFallbackCells?.allCancelled).toBe(0);
  });

  it("R1：void 成行（用真實 API）之後匯出——零逐日格、唔准再印返 section.rawRows 嘅 void 前字面", async () => {
    const voidRes = await voidShiftRecord(req(`http://test.local/api/shift-records/${recordId}/void`, ownerCookie, "POST", { reason: "測試R1作廢" }), {
      params: Promise.resolve({ id: recordId }),
    });
    expect(voidRes.status).toBe(200);

    const after = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const wsAfter = after.workbook.getWorksheet("2026")!;
    const valuesAfter = scanSheet(wsAfter);

    // 核心斷言（R1）：成行 void 晒之後，唔准再喺 xlsx 見到
    // `section.rawRows` 嗰個 void-之前字面 marker——呢個先係 bug 本身
    // （之前會跌落 `rawOnly` fallback，印返舊字面）。
    expect(valuesAfter.includes(RAW_MARKER), "void 咗嘅 section 唔准再跌返 section.rawRows 嘅舊字面").toBe(false);

    // 逐日格會喺下一個 it 用逐格掃描（唔靠估絕對 row number）獨立驗證。

    // 行首欄（R1 容許「仍出（由 guards 推導）或空」，呢度驗證嘅係
    // 「仍出」呢個分支——我哋實際實現用 cancelled 記錄嘅 guard 身份
    // 推導行首欄）：guardA 個名應該仍然搵到。
    expect(valuesAfter.some((v) => v.includes("測試安員甲")), "行首欄應該仍然由 guard 推導出（R1 容許嘅其中一種寫法）").toBe(true);

    // R2：呢一行計落 rawFallbackCells.allCancelled。
    expect(after.rawFallbackCells?.allCancelled).toBe(1);
    expect(after.rawFallbackCells?.external).toBe(0);
    expect(after.rawFallbackCells?.zeroShift).toBe(0);
  });

  it("R1：void 之後嗰行冇任何逐日格代號（逐格掃描確認冧晒）", async () => {
    await voidShiftRecord(req(`http://test.local/api/shift-records/${recordId}/void`, ownerCookie, "POST", { reason: "測試R1作廢" }), {
      params: Promise.resolve({ id: recordId }),
    });
    const after = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const wsAfter = after.workbook.getWorksheet("2026")!;

    // 搵返 guardA 嗰一行（用姓名定位，同 wp3-export-b1-b3.test.ts 一致
    // 手法），確認呢一行日期欄（col7 起）全部空白——唔靠估 row number
    // （section render 出嚟嘅絕對 row 會跟住 section 次序變，唔可以死
    // 記 ROW+N）。
    let guardARow: ExcelJSNS.Row | null = null;
    wsAfter.eachRow((row) => {
      const v = row.getCell(6).value;
      if (typeof v === "string" && v.includes("測試安員甲")) guardARow = row;
    });
    expect(guardARow).not.toBeNull();
    const row = guardARow as unknown as ExcelJSNS.Row;
    for (let col = 7; col <= 7 + 30; col++) {
      expect(row.getCell(col).value, `col=${col} 應該空白（成行 void 晒）`).toBeFalsy();
    }
  });

  it("R2：擾動測試——void 之前 rawFallbackCells.allCancelled=0，void 之後=1，令「同原檔一致嘅行數」呢個分子真係跌咗一格", async () => {
    const before = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const allCancelledBefore = before.rawFallbackCells?.allCancelled ?? 0;

    await voidShiftRecord(req(`http://test.local/api/shift-records/${recordId}/void`, ownerCookie, "POST", { reason: "測試R2擾動" }), {
      params: Promise.resolve({ id: recordId }),
    });

    const after = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const allCancelledAfter = after.rawFallbackCells?.allCancelled ?? 0;

    expect(allCancelledBefore).toBe(0);
    expect(allCancelledAfter).toBe(1);
    expect(allCancelledAfter).toBeGreaterThan(allCancelledBefore); // 擾動後「同原檔一致」嘅計數真係跌（呢個分子加大，覆蓋率會跌）
  });
});
