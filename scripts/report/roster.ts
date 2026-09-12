// 更表（roster）——由 DB 逐盤重出，一個 site 一個 xlsx，版面參考
// tools/importer/out/wp3/reports/roster/*.xlsx（唔要求逐格版面一樣，
// 只要求數值——逐日人手——同源數據一致，見 WP1 回報「已知落差」）。
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../seed/lib/db";
import { parseMonthArg } from "./lib/cli-month";

// P1-WP3：去除寫死 2026-07——`writeRosterXlsx()` 而家收一個可選 `month`
// 參數（default 保留 2026-07，令 report:regen／diff.ts 呢啲冇傳參數嘅舊
// call site 行為不變）。DAYS 唔再硬 31，跟返個月實際日數（例如 4 月 30
// 日），先啱得到 2026-07 以外嘅月份。
export const DEFAULT_REPORT_MONTH = new Date(Date.UTC(2026, 6, 1));

function dayOfMonth(d: Date): number {
  return d.getUTCDate();
}

export async function writeRosterXlsx(outDir: string, month: Date = DEFAULT_REPORT_MONTH) {
  const MONTH_START = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const DAYS = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const MONTH_END = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), DAYS));
  fs.mkdirSync(outDir, { recursive: true });
  const sites = await prisma.site.findMany({
    where: { shiftRecords: { some: { workDate: { gte: MONTH_START, lte: MONTH_END } } } },
    orderBy: { canonicalName: "asc" },
  });

  const perSiteDayHeadcount: Record<string, number[]> = {}; // site.id -> [31] 總人手（俾 diff 用）

  for (const site of sites) {
    // is_external=true（客戶自己嘅人）P0 regen 更表已成行剔走——同一口徑。
    // Opus 驗收 item 3：source='payroll_only'（淨係喺糧單出現、更表冇對應
    // cell 嘅記錄）P0 更表 renderer 本身唔畫呢啲行，DB 側都要剔走先公平比較
    // （呢啲記錄本身喺月結/糧明細報表照計，淨係更表視圖唔顯示）。
    const records = await prisma.shiftRecord.findMany({
      where: { siteId: site.id, workDate: { gte: MONTH_START, lte: MONTH_END }, isExternal: false, source: { not: "payroll_only" } },
      include: { shiftType: true, guard: true },
      orderBy: [{ workDate: "asc" }],
    });

    const dayTotals = new Array(DAYS).fill(0);

    // key = shiftTypeId|guardId -> { code, staffNo, tel, name, days: Map<day, code> }
    type RowAgg = { shiftTypeCode: string; staffNo: string; tel: string; name: string; days: Map<number, string>; count: number };
    const rows = new Map<string, RowAgg>();

    for (const r of records) {
      const day = dayOfMonth(r.workDate);
      const cellCode =
        r.recordType === "shift" || r.recordType === "ot" ? r.shiftType.code : r.leaveCode ?? "?";
      if (r.recordType === "shift") dayTotals[day - 1]++;

      const key = `${r.shiftTypeId}|${r.guardId}`;
      if (!rows.has(key)) {
        rows.set(key, {
          shiftTypeCode: r.shiftType.code,
          staffNo: r.guard.staffNo ?? "",
          tel: r.guard.tel ?? "",
          name: r.guard.nameZh,
          days: new Map(),
          count: 0,
        });
      }
      const row = rows.get(key)!;
      row.days.set(day, cellCode);
      if (r.recordType === "shift") row.count++;
    }

    perSiteDayHeadcount[site.id] = dayTotals;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.addRow([
      "更別",
      "Staff No.",
      "電話",
      "姓名",
      ...Array.from({ length: DAYS }, (_, i) => String(i + 1)),
      "月總更數",
    ]);
    for (const row of [...rows.values()].sort((a, b) => a.shiftTypeCode.localeCompare(b.shiftTypeCode))) {
      ws.addRow([
        row.shiftTypeCode,
        row.staffNo,
        row.tel,
        row.name,
        ...Array.from({ length: DAYS }, (_, i) => row.days.get(i + 1) ?? ""),
        row.count,
      ]);
    }
    ws.addRow(["Total", "", "", "", ...dayTotals, dayTotals.reduce((a, b) => a + b, 0)]);

    const daily = await prisma.dailyRequirement.groupBy({
      by: ["workDate"],
      where: { siteId: site.id, workDate: { gte: MONTH_START, lte: MONTH_END } },
      _sum: { headcountRequired: true },
    });
    const reqByDay = new Array(DAYS).fill(0);
    for (const d of daily) reqByDay[dayOfMonth(d.workDate) - 1] = d._sum.headcountRequired ?? 0;
    ws.addRow(["所需人手", "", "", "", ...reqByDay, reqByDay.reduce((a, b) => a + b, 0)]);
    ws.addRow([
      "尚欠",
      "",
      "",
      "",
      ...reqByDay.map((req, i) => Math.max(0, req - dayTotals[i])),
      "",
    ]);

    const safeName = site.canonicalName.replace(/[\\/:*?"<>|]/g, "_");
    await wb.xlsx.writeFile(path.join(outDir, `Roster - ${safeName}.xlsx`));
  }

  return perSiteDayHeadcount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(process.cwd(), "out/p1/roster");
  const month = parseMonthArg(process.argv.slice(2));
  writeRosterXlsx(out, month).then(() => {
    console.log("wrote roster xlsx to", out);
    prisma.$disconnect();
  });
}
