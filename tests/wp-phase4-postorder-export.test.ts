// §20.4 Phase 4（branch wp-phase4）：`buildPostorderWorkbook()` 單元／
// integration 測試。
//
// 鐵則遵守：唔用真名／真工號／真電話／身份證——安員/雞頭/盤全部用合成
// 測試代號（「測試安員A」呢類），測試月份揀一個同真實資料完全唔撞嘅
// 月份（2025-08，同 gross-margin-empty-month.test.ts 一致嘅慣例：
// 2025-xx 月份業務未開始，冇任何真實 seed 資料會撞落嚟）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ExcelJS from "exceljs";
import { clearAll, prisma } from "./lib/db";
import { buildPostorderWorkbook, sanitizeSheetName, POSTORDER_SHEET_NAMES, longtermRowPayoutRate, summaryTotalsFrom } from "@/lib/reports/postorder-export";

describe("longtermRowPayoutRate（長工行外判價＝月薪÷當月更數，Opus 5.5 驗收）", () => {
  it("一人一行做足全月＝月薪÷更數", () => {
    expect(longtermRowPayoutRate(new Map([["g1", 26]]), new Map([["g1", 26]]), new Map([["g1", { kind: "monthly", monthlySalary: 26000 }]]))).toBe(1000);
  });
  it("同一人分散兩行按更數比例拆，唔會每行計足一次月薪", () => {
    const total = new Map([["g1", 30]]);
    const basis = new Map([["g1", { kind: "monthly" as const, monthlySalary: 30000 }]]);
    const a = longtermRowPayoutRate(new Map([["g1", 20]]), total, basis)!;
    const b = longtermRowPayoutRate(new Map([["g1", 10]]), total, basis)!;
    expect(a * 20 + b * 10).toBe(30000);
    expect(a).toBe(1000);
  });
  it("日薪制直接用每更價；冇薪金資料就留空（唔屈 0）", () => {
    expect(longtermRowPayoutRate(new Map([["g1", 5]]), new Map([["g1", 5]]), new Map([["g1", { kind: "daily", dailyRate: 600 }]]))).toBe(600);
    expect(longtermRowPayoutRate(new Map([["g1", 5]]), new Map([["g1", 5]]), new Map())).toBeNull();
  });
});

describe("summaryTotalsFrom（Summary 總收入／成本／毛利＝一鍵結算報告口徑）", () => {
  const close = { mainRows: [{ revenue: 1000 }], outsideRows: [{ revenue: 200 }] } as never;
  it("有長工糧 run＋合併摘要 → 合併成本", () => {
    const gm = { totals: { revenue: 1000, cost: 700, profit: 300 }, combinedCostSummary: { combinedCostTotal: 800 } } as never;
    expect(summaryTotalsFrom(close, gm, true)).toEqual({ revenue: 1200, marginRevenue: 1000, cost: 800, grossMargin: 200, costBasis: "combined" });
  });
  it("冇長工糧 run → 毛利表舊口徑", () => {
    const gm = { totals: { revenue: 1000, cost: 700, profit: 300 }, combinedCostSummary: { combinedCostTotal: 800 } } as never;
    expect(summaryTotalsFrom(close, gm, false)).toEqual({ revenue: 1200, marginRevenue: 1000, cost: 700, grossMargin: 300, costBasis: "legacy" });
  });
});

describe("sanitizeSheetName（Excel 規則：sheet 名唔可以有 / \\ ? * [ ] :，含全形）", () => {
  it("剔走半形同全形禁字元", () => {
    expect(sanitizeSheetName("A/B\\C?D*E[F]G:H")).toBe("A-B-C-D-E-F-G-H");
    expect(sanitizeSheetName("盤／甲＼乙？丙＊丁［戊］己：庚")).toBe("盤-甲-乙-丙-丁-戊-己-庚");
  });
  it("長度截到 31 字元", () => {
    const long = "x".repeat(40);
    expect(sanitizeSheetName(long).length).toBeLessThanOrEqual(31);
  });
  it("空字串／全禁字元唔會出返空 sheet 名", () => {
    expect(sanitizeSheetName("")).toBe("sheet");
    expect(sanitizeSheetName("///")).not.toBe("");
  });
});

const TEST_MONTH = new Date(Date.UTC(2025, 7, 1)); // 2025-08——同真實 2026 資料完全唔撞

describe("buildPostorderWorkbook（合成小月份）", () => {
  let siteId: string;
  let shiftTypeId: string;
  let brokerCashId: string;
  let brokerLongtermId: string;
  let guardCasualId: string;
  let guardLongtermId: string;
  let eventSiteId: string;

  beforeAll(async () => {
    await clearAll();

    const site = await prisma.site.create({
      data: {
        canonicalName: "測試物業-戊",
        aliases: ["戊", "測試物業戊"],
        clientName: "測試客戶戊",
        billingModel: "per_shift",
        inScope: true,
        status: "active",
        createdBy: "test",
      },
    });
    siteId = site.id;

    const shiftType = await prisma.shiftType.create({
      data: { siteId, code: "N", label: "夜更", billingGroup: "per_shift", createdBy: "test" },
    });
    shiftTypeId = shiftType.id;

    const brokerCash = await prisma.broker.create({
      data: { code: "TB1", name: "測試雞頭一", kind: "broker", settlementType: "cash", createdBy: "test" },
    });
    brokerCashId = brokerCash.id;

    const brokerLongterm = await prisma.broker.upsert({
      where: { code: "B07" },
      update: {},
      create: { code: "B07", name: "B07", kind: "internal_longterm", settlementType: "autopay", createdBy: "test" },
    });
    brokerLongtermId = brokerLongterm.id;

    const guardCasual = await prisma.guard.create({
      data: { nameZh: "測試安員甲", employmentType: "cash_casual", status: "active", createdBy: "test" },
    });
    guardCasualId = guardCasual.id;

    const guardLongterm = await prisma.guard.create({
      data: { nameZh: "測試安員乙", employmentType: "longterm_autopay", monthlySalary: 15000, status: "active", createdBy: "test" },
    });
    guardLongtermId = guardLongterm.id;

    // 名以「=」開頭嘅長工（鐵則：`=` 開頭字串要當文字，唔可以變公式）
    const guardEq = await prisma.guard.create({
      data: { nameZh: "=1+1測試安員丙", employmentType: "longterm_autopay", monthlySalary: 9000, status: "active", createdBy: "test" },
    });
    await prisma.shiftRecord.create({
      data: { workDate: new Date(Date.UTC(2025, 7, 7)), siteId, shiftTypeId, guardId: guardEq.id, settlementBrokerId: brokerLongtermId, recordType: "shift", status: "confirmed", clientRateSnapshot: null, guardWageSnapshot: 0, brokerFeeSnapshot: 0, createdBy: "test" },
    });

    // Event 分盤：「測試物業-戊 Event」——應該放喺母盤 block（物業名稱「戊」、更份「Event …」）
    const eventSite = await prisma.site.create({
      data: { canonicalName: "測試物業-戊 Event", aliases: ["測試物業戊活動更"], clientName: "測試客戶戊", billingModel: "per_shift", inScope: true, status: "active", createdBy: "test" },
    });
    eventSiteId = eventSite.id;
    const eventShift = await prisma.shiftType.create({ data: { siteId: eventSite.id, code: "D", label: "日更", billingGroup: "per_shift", createdBy: "test" } });
    await prisma.shiftRecord.create({
      data: { workDate: new Date(Date.UTC(2025, 7, 8)), siteId: eventSite.id, shiftTypeId: eventShift.id, guardId: guardCasualId, settlementBrokerId: brokerCashId, recordType: "shift", status: "confirmed", clientRateSnapshot: 1350, guardWageSnapshot: 990, brokerFeeSnapshot: 0, createdBy: "test" },
    });

    // 散工雞頭行：3 更，client_rate=900/guard_wage=700
    for (const day of [1, 2, 3]) {
      await prisma.shiftRecord.create({
        data: {
          workDate: new Date(Date.UTC(2025, 7, day)),
          siteId,
          shiftTypeId,
          guardId: guardCasualId,
          settlementBrokerId: brokerCashId,
          recordType: "shift",
          status: "confirmed",
          clientRateSnapshot: 900,
          guardWageSnapshot: 700,
          brokerFeeSnapshot: 50,
          createdBy: "test",
        },
      });
    }
    // 長工（B07）行：2 更
    for (const day of [4, 5]) {
      await prisma.shiftRecord.create({
        data: {
          workDate: new Date(Date.UTC(2025, 7, day)),
          siteId,
          shiftTypeId,
          guardId: guardLongtermId,
          settlementBrokerId: brokerLongtermId,
          recordType: "shift",
          status: "confirmed",
          clientRateSnapshot: null,
          guardWageSnapshot: 0,
          brokerFeeSnapshot: 0,
          createdBy: "test",
        },
      });
    }
    // 一條已取消——唔應該入 shiftCount，但要入「取消」尾欄
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2025, 7, 6)),
        siteId,
        shiftTypeId,
        guardId: guardCasualId,
        settlementBrokerId: brokerCashId,
        recordType: "shift",
        status: "cancelled",
        clientRateSnapshot: 900,
        guardWageSnapshot: 700,
        brokerFeeSnapshot: 50,
        createdBy: "test",
      },
    });
  });

  afterAll(async () => {
    await prisma.shiftRecord.deleteMany({ where: { siteId: { in: [siteId, eventSiteId] } } });
  });

  it("四個 sheet，名同任務書一致，冇犯 Excel sheet 名禁字元規則", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const names = workbook.worksheets.map((ws) => ws.name);
    expect(names).toEqual([POSTORDER_SHEET_NAMES.roster, POSTORDER_SHEET_NAMES.postOrder, POSTORDER_SHEET_NAMES.summary, POSTORDER_SHEET_NAMES.legend]);
    for (const name of names) {
      expect(name).not.toMatch(/[/\\?*[\]:／＼？＊［］：]/);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(31);
    }
  });

  it("全部 sheet 冇任何空字串格（鐵則）", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    for (const ws of workbook.worksheets) {
      ws.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          expect(cell.value).not.toBe("");
        });
      });
    }
  });

  it("冇任何字串格用 exceljs formula 物件寫（即冇 cell 被解析做公式）", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    for (const ws of workbook.worksheets) {
      ws.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        });
      });
    }
  });

  it("Roster：散工雞頭行同長工(B07)行分開兩行，欄位語意正確", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.roster)!;
    const header = ws.getRow(1).values as unknown[];
    expect(header[1]).toBe("客戶名稱");
    expect(header[2]).toBe("物業名稱");
    expect(header[3]).toBe("更份/時段");
    expect(header[4]).toBe("上單價");
    expect(header[5]).toBe("外判價");
    expect(header[6]).toBe("時間");

    const rows: Record<number, unknown[]> = {};
    for (let r = 2; r <= ws.rowCount; r++) rows[r] = ws.getRow(r).values as unknown[];
    // 物業名稱格（col 2）出「戊」——aliases 入面最短嗰個（"戊"）攞晒
    // canonicalName（"測試物業-戊"）優先，符合任務書「aliases 入面最短
    // 嗰個或 canonical；如冇就 canonical」。
    const casualRow = Object.values(rows).find((v) => v[2] === "戊" && v[3] === "夜更" && v[4] === 900);
    const longtermRow = Object.values(rows).find((v) => v[2] === "戊" && v[3] === "夜更" && v[4] === undefined);
    expect(casualRow, "散工雞頭行要搵到").toBeTruthy();
    expect(longtermRow, "長工(B07)行要搵到").toBeTruthy();
    // 真 Postorder：長工行「上單價」(E)＝收客價（呢度 null → 留空），「外判價」(F)
    // ＝月薪÷當月更數（原本 #REF!）：乙 15000 做 2 更＋丙 9000 做 1 更 → 24000÷3＝8000
    expect(longtermRow![5]).toBe(8000);
  });

  it("Roster：日期格＝盤簡稱（aliases 最短嗰個），長工日備註＝安員姓名", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.roster)!;
    // 第 4 日（col = 6 頭 + (4-1)*7 + 1 = 27）應該係長工行嘅日期格
    let found = false;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const dateCell = row.getCell(6 + (4 - 1) * 7 + 1).value;
      const noteCell = row.getCell(6 + (4 - 1) * 7 + 3).value;
      if (dateCell === "戊") {
        found = true;
        expect(noteCell).toBe("測試安員乙");
      }
    }
    expect(found, "第 4 日盤簡稱格要搵到").toBe(true);
  });

  it("Roster：「=」開頭嘅字串（安員名）照寫文字，唔變公式（鐵則）", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.roster)!;
    let found = false;
    ws.eachRow((row) => {
      const c = row.getCell(6 + (7 - 1) * 7 + 3);
      if (c.value === "=1+1測試安員丙") {
        found = true;
        expect(c.type).toBe(ExcelJS.ValueType.String);
      }
    });
    expect(found).toBe(true);
  });

  it("Roster：Event 分盤放喺母盤 block（物業名稱同母盤、更份加 Event、排喺母盤後面）", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.roster)!;
    const labels: string[] = [];
    for (let r = 2; r <= ws.rowCount; r++) labels.push(`${ws.getRow(r).getCell(2).value}|${ws.getRow(r).getCell(3).value}`);
    const eventIdx = labels.indexOf("戊|Event 日更");
    expect(eventIdx).toBeGreaterThan(-1);
    expect(labels.slice(0, eventIdx).every((l) => l.startsWith("戊|"))).toBe(true);
  });

  it("Roster：取消尾欄 = 1（一條已取消記錄），甩更恆 0", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.roster)!;
    const tailStart = 6 + 31 * 7 + 1; // 取消欄（假設 31 日；實際用 daysInMonth 算，2025-08=31 日）
    let sawCancelled = false;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cancelled = row.getCell(tailStart).value;
      const noShow = row.getCell(tailStart + 1).value;
      expect(noShow === 0 || noShow === undefined || noShow === null).toBe(true);
      if (cancelled === 1) sawCancelled = true;
    }
    expect(sawCancelled).toBe(true);
  });

  it("Summary：逐雞頭付款 amount = guard_wage+broker_fee 之和（測試雞頭一 = 3×750＋Event 990＝3240）", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.summary)!;
    let foundAmount: number | null = null;
    ws.eachRow((row) => {
      if (row.getCell(2).value === "測試雞頭一") foundAmount = row.getCell(6).value as number;
    });
    expect(foundAmount).toBe(3240);
  });

  it("PostOrder：每日一欄，Total Shift 同 Roster 更數一致", async () => {
    const { workbook } = await buildPostorderWorkbook(TEST_MONTH);
    const ws = workbook.getWorksheet(POSTORDER_SHEET_NAMES.postOrder)!;
    const header = ws.getRow(1).values as unknown[];
    expect(header[1]).toBe("物業名稱");
    expect(header[header.length - 1]).toBe("Total Shift");
    let sawCasualTotal = false;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.getCell(1).value === "戊" && row.getCell(row.cellCount).value === 3) sawCasualTotal = true;
    }
    expect(sawCasualTotal).toBe(true);
  });

  it("回傳嘅 summary 數字（siteRevenueTotal/siteCostTotal/rosterRowCount）啱數", async () => {
    const result = await buildPostorderWorkbook(TEST_MONTH);
    expect(result.rosterRowCount).toBe(3); // 散工行 + 長工行 + Event 行
    expect(result.siteRevenueTotal).toBe(4050); // 3 × 900 + 1350
    expect(result.siteCostTotal).toBe(3240); // 3 × 750 + 990
  });
});
