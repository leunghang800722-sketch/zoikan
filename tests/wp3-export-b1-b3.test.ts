// Opus 對抗式驗收第三輪（B1／B3，兩條匯出必修）：
// B1 雞頭版匯出（`buildRosterWorkbookForSite(..., {broker_id})`）唔可以
// 洩漏其他雞頭嘅保安員（真名/工號/電話/英文名）——逐格掃描整份 xlsx，
// 確保零命中，同埋格數要明顯少過老闆版（冇 brokerId）匯出。
// B3 作廢（status=cancelled）嘅更次唔可以再印落 xlsx——用真實 void API
// 作廢一格，重新匯出，斷言嗰一格變晒空白。
//
// 用 tests/fixtures/wp2-fixture.ts 現成嘅 brokerA/guardA/brokerB/guardB
// （同一個 site、同一個 shiftType、同一日），冇任何真名/工號/電話
// （PDPO——全部「測試」開頭嘅假資料）。呢個 site 冇 roster_layout 模板，
// 匯出行 `buildGenericRosterWorkbook()` 路徑（唔靠 raw 字面 fallback，
// 純粹逐格對住 DB 記錄推導——同真實新 site 一致）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type ExcelJSNS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildRosterWorkbookForSite } from "../src/lib/roster-export";
import { POST as voidShiftRecord } from "@/app/api/shift-records/[id]/void/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

/** 逐格掃描一個 worksheet，回傳 { cellCount, values }（values 係全部
 * 非空格嘅字串化內容，唔理格式，純粹用嚟做 substring 命中檢查）。 */
function scanSheet(ws: ExcelJSNS.Worksheet): { cellCount: number; values: string[] } {
  const values: string[] = [];
  let cellCount = 0;
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value === null || cell.value === undefined || cell.value === "") return;
      cellCount++;
      values.push(String(cell.value));
    });
  });
  return { cellCount, values };
}

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("Opus 對抗式驗收第三輪 B1：雞頭版匯出唔可以洩漏其他雞頭嘅保安員", () => {
  it("brokerA 版匯出：掃描全份 xlsx，零命中 brokerB 嘅 guardB 姓名/工號/電話；格數明顯少過老闆版", async () => {
    const fx = await seedWp2Fixture();

    // 老闆版（冇 brokerId）：兩個雞頭嘅保安員行都應該出到（對照組，
    // 順便確認 fixture 本身真係會產生一個「同一個 block 入面有兩個
    // 唔同雞頭嘅保安員」嘅情況，B1 個 fix 先測得有意義）。
    const ownerResult = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const ownerWs = ownerResult.workbook.getWorksheet("2026")!;
    const ownerScan = scanSheet(ownerWs);
    expect(ownerScan.values.some((v) => v.includes("測試保安員乙"))).toBe(true); // guardB 應該喺老闆版見得到

    // brokerA 版：guardB 嘅真名/工號/電話一律唔准出現。
    const brokerAResult = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth, { brokerId: fx.brokerA.id });
    const brokerAWs = brokerAResult.workbook.getWorksheet("2026")!;
    const brokerAScan = scanSheet(brokerAWs);

    const guardBNeedles = ["測試保安員乙", "T-B01", "6100 002", "61000 02", "6100002"];
    for (const needle of guardBNeedles) {
      const hits = brokerAScan.values.filter((v) => v.includes(needle));
      expect(hits, `brokerA 版匯出唔應該出現 guardB 嘅 "${needle}"：命中 ${JSON.stringify(hits)}`).toEqual([]);
    }
    // 連 brokerB 個 code 本身都唔應該出現（雞頭代號欄）。
    expect(brokerAScan.values.some((v) => v.includes(fx.brokerB.name))).toBe(false);
    expect(brokerAScan.values.some((v) => v.includes("TEST-BB"))).toBe(false);

    // brokerA 版格數要明顯少過老闆版（老闆版兩個保安員行都有，brokerA
    // 版淨係得自己一行，guardB 嗰行留空）。
    expect(brokerAScan.cellCount).toBeLessThan(ownerScan.cellCount);

    // brokerA 自己嘅保安員（guardA）梗係要仲見得到——唔係一刀切清晒個 sheet。
    expect(brokerAScan.values.some((v) => v.includes("測試保安員甲"))).toBe(true);
  });

  it("brokerB 版匯出：反過來零命中 guardA", async () => {
    const fx = await seedWp2Fixture();
    const brokerBResult = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth, { brokerId: fx.brokerB.id });
    const brokerBWs = brokerBResult.workbook.getWorksheet("2026")!;
    const brokerBScan = scanSheet(brokerBWs);

    const guardANeedles = ["測試保安員甲", "T-A01"];
    for (const needle of guardANeedles) {
      const hits = brokerBScan.values.filter((v) => v.includes(needle));
      expect(hits, `brokerB 版匯出唔應該出現 guardA 嘅 "${needle}"：命中 ${JSON.stringify(hits)}`).toEqual([]);
    }
    expect(brokerBScan.values.some((v) => v.includes("測試保安員乙"))).toBe(true); // 自己嘅仲見得到
  });
});

describe("Opus 對抗式驗收第三輪 B3：作廢咗嘅更次唔可以再印落匯出", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("void shiftRecordA（真實 API）之後匯出，果一格變空白；隔離嘅其他格唔受影響", async () => {
    // Void 之前：先確認呢一格真係印緊嘢（day=1，跟 fixture 嘅
    // workDate=2026-08-01）。
    const before = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const wsBefore = before.workbook.getWorksheet("2026")!;
    const beforeScan = scanSheet(wsBefore);
    expect(beforeScan.values.some((v) => v.includes("測試保安員甲"))).toBe(true);

    // 用真實 void API 作廢（老闆角色，「更表:void」冇硬性 deny）。
    const voidRes = await voidShiftRecord(req(`http://test.local/api/shift-records/${fx.shiftRecordA.id}/void`, ownerCookie, "POST", { reason: "測試B3作廢" }), {
      params: Promise.resolve({ id: fx.shiftRecordA.id }),
    });
    expect(voidRes.status).toBe(200);
    const voided = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(voided.status).toBe("cancelled");

    // Void 之後：guardA 成行喺呢個 shift_type 嘅 block 應該完全唔再出現
    // （呢個 site 得 guardA 一個人做呢個 shift_type，冧走成行——同
    // `buildGenericRosterWorkbook` 嘅 `activeRecords.length===0` 邏輯
    // 一致），guardA 嘅名唔應該再喺 xlsx 出現。
    const after = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const wsAfter = after.workbook.getWorksheet("2026")!;
    const afterScan = scanSheet(wsAfter);
    expect(afterScan.values.some((v) => v.includes("測試保安員甲")), "作廢咗嘅記錄唔應該再印落匯出").toBe(false);

    // guardB（同一個 site、另一個雞頭）嘅記錄冇被 void 過，唔應該受影響。
    expect(afterScan.values.some((v) => v.includes("測試保安員乙"))).toBe(true);
  });

  it("同一個保安員喺同一個 shift_type 多過一格：void 其中一格，另一格照印（唔係一刀切成行）", async () => {
    // 幫 guardA 加多一日記錄（同一個 shift_type，第 2 日），等呢個
    // guard 喺呢個 block 有兩格：一格 void、一格保留。
    const secondRecord = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 2)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: (await prisma.guard.findUniqueOrThrow({ where: { id: (await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } })).guardId } })).id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test-b3",
      },
    });

    await voidShiftRecord(req(`http://test.local/api/shift-records/${fx.shiftRecordA.id}/void`, ownerCookie, "POST", { reason: "測試B3作廢" }), {
      params: Promise.resolve({ id: fx.shiftRecordA.id }),
    });

    const result = await buildRosterWorkbookForSite(fx.site.id, fx.unlockedMonth);
    const ws = result.workbook.getWorksheet("2026")!;

    // guardA 呢一行仲要存在（因為第 2 日嗰格仲係 active）。
    const scan = scanSheet(ws);
    expect(scan.values.some((v) => v.includes("測試保安員甲"))).toBe(true);

    // 逐行搵返 guardA 嗰行，第 1 格（day1，已 void）應該空白，
    // 第 2 格（day2，未 void）應該有更別代號。呢度用 row.values 直接
    // 逐格睇（generic layout labelCol=6，day1=col7、day2=col8）。
    let guardARow: ExcelJSNS.Row | null = null;
    ws.eachRow((row) => {
      const first = row.getCell(6).value; // labelCol=6=姓名（standard layout）
      if (typeof first === "string" && first.includes("測試保安員甲")) guardARow = row;
    });
    expect(guardARow, "搵唔到 guardA 嗰行").not.toBeNull();
    const row = guardARow as unknown as ExcelJSNS.Row;
    expect(row.getCell(7).value, "day1（已 void）應該空白").toBeFalsy();
    expect(row.getCell(8).value, "day2（未 void）應該有更別代號").toBeTruthy();

    expect(secondRecord.status).not.toBe("cancelled"); // sanity：第二格本身冇被 void
  });
});
