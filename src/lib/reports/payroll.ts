// 糧明細——由 DB 逐結算單位（雞頭/broker）重出。
// P1-WP4：由 scripts/report/payroll.ts 搬入呢度（單一 source of truth，
// scripts/report/payroll.ts 而家係 thin wrapper；`GET /api/reports/payroll`
// 用返同一份邏輯）。
//
// 注：P0 嘅 out/wp3/reports/payroll/雞頭糧明細-regenerated.xlsx 仲拆到
// 逐頁（settlement_page，例：某雞頭-1331 / 某雞頭-LINK / 總表確認-K…）咁細粒度，
// 反映原始紙本糧單嘅頁面邊界。WP1 呢度以 broker 為單位（粗一級），
// 逐 broker 總額對得起 P0 逐頁總額之和（見 WP1 回報「已知落差」，
// 精確逐頁重現留返規劃 session 決定是否需要）。
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2 } from "./money";

export const DEFAULT_REPORT_MONTH = new Date(Date.UTC(2026, 6, 1));
function monthRange(month: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { start, end };
}

// P2-B（README §14「種類 pill」欄）additive：`brokerKind` 直接搬 broker.kind
// 過嚟，冇加任何查詢，`writePayrollXlsx()`／既有 API 消費者唔受影響
// （多一個 key，唔係改咗原有 key 嘅意思）。
// P0（Opus 驗收重現）：`brokerId` 而家可以係 `null`——呢個 sentinel 代表
// `settlement_broker_id IS NULL` 嗰批記錄（同全部真正 broker 完全分開查
// ——之前呢類記錄逐 broker 查嘅時候完全跌漏，糧明細見唔到）。前端／
// 匯出見到 `brokerId === null` 就顯示做「未歸屬結算單位」呢一行，等
// 用戶知呢筆金額／更數仲未有人認領，唔係「唔存在」。
export type BrokerPayrollTotal = { brokerId: string | null; brokerName: string; brokerCode: string; brokerKind: string; shifts: number; wage: number; fee: number; amount: number };
const UNATTRIBUTED_BROKER_LABEL = "未歸屬結算單位";

// 驗收修正（Opus 5.5，WP-ROSTER-UPLOAD B1）：糧單一律排除 `status=
// cancelled`——之前完全冇篩 status，但 B1 對數套用（system_only／
// guard_diff／shift_type_diff）同更表編輯器清格都係將記錄轉 cancelled，
// 唔排除就會「舊人＋新人」兩份糧都計。7 月冇 cancelled 記錄，數字唔變。
export async function buildPayrollTotals(month: Date = DEFAULT_REPORT_MONTH): Promise<BrokerPayrollTotal[]> {
  const { start, end } = monthRange(month);
  const brokers = await prisma.broker.findMany({ orderBy: { code: "asc" } });
  const out: BrokerPayrollTotal[] = [];
  for (const b of brokers) {
    const agg = await prisma.shiftRecord.aggregate({
      where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
      _count: { _all: true },
      _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
    });
    const wage = round2(n(agg._sum.guardWageSnapshot));
    const fee = round2(n(agg._sum.brokerFeeSnapshot));
    if (agg._count._all === 0 && wage === 0 && fee === 0) continue;
    out.push({
      brokerId: b.id,
      brokerName: b.name,
      brokerCode: b.code,
      brokerKind: b.kind,
      shifts: agg._count._all,
      wage,
      fee,
      amount: round2(wage + fee),
    });
  }

  // D 項（Opus 驗收重現）：settlement_broker_id IS NULL 嘅記錄——理論上
  // 而家 batch/route.ts＋單筆 POST 都有完整 fallback 鏈，唔應該再有新
  // 記錄跌落呢度；但（a）7 月鎖定咗嘅歷史記錄、（b）fallback 鏈全部級
  // 都搵唔到（全新安員、乜歷史都冇、又唔係長工）嗰種邊緣情況，仍然
  // 可能出現。呢種記錄一律唔准再靜靜喺報表消失——逐 broker 查完之後，
  // 加多一次獨立查詢，一有就加一行「未歸屬結算單位」（金額計入 Total，
  // 等會計一眼見到有錢未歸邊個雞頭）。
  const unattributedAgg = await prisma.shiftRecord.aggregate({
    where: { settlementBrokerId: null, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
    _count: { _all: true },
    _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
  });
  if (unattributedAgg._count._all > 0) {
    const wage = round2(n(unattributedAgg._sum.guardWageSnapshot));
    const fee = round2(n(unattributedAgg._sum.brokerFeeSnapshot));
    out.push({
      brokerId: null,
      brokerName: UNATTRIBUTED_BROKER_LABEL,
      brokerCode: "",
      brokerKind: "unattributed",
      shifts: unattributedAgg._count._all,
      wage,
      fee,
      amount: round2(wage + fee),
    });
  }

  return out;
}

// WP-ROSTER-UPLOAD Phase B-1（B1-7）：糧明細來源標記——additive，唔改
// `buildPayrollTotals()`／`writePayrollXlsx()` 既有欄位／totals 計法
// （7 月數字唔准變，gate:reports／gate:pricing／report:regen 全部要
// 過）。`shift_records.source` 現存絕大部份記錄係 `null`（batch/route.ts
// ／單筆 POST 之前冇寫過呢個欄，見 reconcile-apply.ts 頂註解——淨係
// 我哋新嘅對數套用寫入會填 `source='roster_upload'`），呢度原樣統計
// 實際存底嘅值，`null` 顯示做「未標記」，唔喺呢度估返一個值。 */
export interface PayrollSourceSummary {
  /** `source='roster_upload'`（Phase B-1 對數套用寫入）嘅更數。 */
  rosterUploadCount: number;
  /** `source` 有值但唔係 `roster_upload`（例如未來雞頭報/人手/複製上月
   * 呢類標記，現時未有任何路徑會寫呢類值，見回報「已知落差」）嘅更數。 */
  otherSourceCount: number;
  /** `source IS NULL`（絕大部份現存記錄，包括 7 月歷史資料）嘅更數。 */
  unlabeledCount: number;
  /** 原始 `source` 值 → 更數，`"（未標記）"` 代表 null。 */
  bySource: Record<string, number>;
}

export async function buildPayrollSourceSummary(month: Date = DEFAULT_REPORT_MONTH): Promise<PayrollSourceSummary> {
  const { start, end } = monthRange(month);
  const grouped = await prisma.shiftRecord.groupBy({
    by: ["source"],
    where: { recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
    _count: { _all: true },
  });
  const bySource: Record<string, number> = {};
  let rosterUploadCount = 0;
  let otherSourceCount = 0;
  let unlabeledCount = 0;
  for (const g of grouped) {
    const label = g.source ?? "（未標記）";
    bySource[label] = (bySource[label] ?? 0) + g._count._all;
    if (g.source === "roster_upload") rosterUploadCount += g._count._all;
    else if (g.source === null) unlabeledCount += g._count._all;
    else otherSourceCount += g._count._all;
  }
  return { rosterUploadCount, otherSourceCount, unlabeledCount, bySource };
}

export async function writePayrollXlsx(outPath: string, month: Date = DEFAULT_REPORT_MONTH) {
  const { start, end } = monthRange(month);
  const totals = await buildPayrollTotals(month);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("糧明細總表(按雞頭)");
  ws.addRow(["結算單位(雞頭)", "代號", "更數", "工資", "雞頭費", "金額"]);
  for (const t of totals) {
    ws.addRow([t.brokerName, t.brokerCode, t.shifts, t.wage, t.fee, t.amount]);
  }
  ws.addRow([
    "Total",
    "",
    totals.reduce((a, t) => a + t.shifts, 0),
    round2(totals.reduce((a, t) => a + t.wage, 0)),
    round2(totals.reduce((a, t) => a + t.fee, 0)),
    round2(totals.reduce((a, t) => a + t.amount, 0)),
  ]);

  // 逐安員明細（每個 broker 一個 sheet），方便人手覆核
  const brokers = await prisma.broker.findMany();
  // B1-7：逐更來源明細（additive 新 sheet，唔改上面任何一個既有 sheet/
  // 欄位）——同一次查詢順便收集，唔加多一round DB 查詢。
  const sourceDetailRows: { date: string; brokerCode: string; guardName: string; guardStaffNo: string; source: string }[] = [];
  for (const b of brokers) {
    const records = await prisma.shiftRecord.findMany({
      where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
      include: { guard: true },
    });
    if (records.length === 0) continue;
    const byGuard = new Map<string, { name: string; staffNo: string; shifts: number; amount: number }>();
    for (const r of records) {
      const key = r.guardId;
      if (!byGuard.has(key)) {
        byGuard.set(key, { name: r.guard.nameZh, staffNo: r.guard.staffNo ?? "", shifts: 0, amount: 0 });
      }
      const g = byGuard.get(key)!;
      g.shifts++;
      g.amount = round2(g.amount + n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot));
      sourceDetailRows.push({
        date: r.workDate.toISOString().slice(0, 10),
        brokerCode: b.code,
        guardName: r.guard.nameZh,
        guardStaffNo: r.guard.staffNo ?? "",
        source: r.source ?? "（未標記）",
      });
    }
    const safeName = b.name.replace(/[\\/:*?"<>|[\]]/g, "_").slice(0, 28);
    const sheet = wb.addWorksheet(`${b.code || "?"}-${safeName}`);
    sheet.addRow(["Staff No.", "姓名", "更數", "金額"]);
    for (const g of byGuard.values()) sheet.addRow([g.staffNo, g.name, g.shifts, g.amount]);
  }

  // B1-7：頂部摘要——roster_upload 更數 vs 其他來源更數（additive 新
  // sheet）。
  const sourceSummary = await buildPayrollSourceSummary(month);
  const summarySheet = wb.addWorksheet("來源摘要");
  summarySheet.addRow(["更表上載（roster_upload）更數", sourceSummary.rosterUploadCount]);
  summarySheet.addRow(["其他已標記來源更數", sourceSummary.otherSourceCount]);
  summarySheet.addRow(["未標記來源更數", sourceSummary.unlabeledCount]);
  summarySheet.addRow([]);
  summarySheet.addRow(["來源", "更數"]);
  for (const [label, count] of Object.entries(sourceSummary.bySource)) summarySheet.addRow([label, count]);

  const detailSheet = wb.addWorksheet("逐更來源明細");
  detailSheet.addRow(["日期", "結算單位代號", "Staff No.", "姓名", "來源"]);
  for (const row of sourceDetailRows) detailSheet.addRow([row.date, row.brokerCode, row.guardStaffNo, row.guardName, row.source]);

  await wb.xlsx.writeFile(outPath);
  return totals;
}
