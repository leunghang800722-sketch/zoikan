// §20.4 Phase 4（老闆 2026-09-27 指令，branch `wp-phase4`）：系統輸出
// 「Postorder 格式總表 Excel」——老闆決定唔再自己維護 Postorder，總表
// 由系統計出嚟。
//
// **呢個唔係「Postorder 上載」嗰個既有功能**（`src/lib/guard-fix/
// postorder.ts`／`postorder_uploads` 表、`computeReferralFeesForMonth()`
// 讀嘅嗰個係*輸入*，用嚟做介紹費/長工結算單位對數用）——呢個模組係
// *輸出*：`buildPostorderWorkbook()` 由 `shift_records`（非 cancelled）
// ＋現有幾個報表模組（`payroll.ts` 逐雞頭付款、`referral-fee.ts` 介紹
// 費、`monthly-close.ts` 營業額/成本/毛利/長工糧 run）砌返一份同真
// Postorder（`data/2026-09/msg-file/Postorder - Aug 2026.xlsm`）欄位語意
// 同位置一致嘅 xlsx——**唔追求 100% 同樣式**（見任務書），數字口徑一律
// 借用已經 gate 過嘅 pure function，唔重新發明公式。
//
// 三個 sheet：
//   Roster    — 逐 (盤, 更種/時段, 結算單位) 一行，日曆 block（日期格＝
//               盤簡稱／雞頭／備註／其他／救更價／Unbilled／Paid）＋
//               尾欄（取消／甩更／當月更數／當月收入／當月成本／當月GP）。
//   PostOrder — 同 Roster 逐行對應嘅精簡版（每日一欄，Total Shift），
//               另加「長工雞頭費 (雞頭)」逐雞頭逐盤介紹費行。
//   Summary   — 逐雞頭付款（SUMIF 語意）、半月結 01-15/16-31、介紹費、
//               K passthrough 提示行、長工 Autopay/MPF、總收入/成本/毛利。
//   口徑說明  — 純文字，逐欄口徑同已知限制/差異（唔屈估，見 §19）。
//
// **已知限制**（老實列出，唔屈估——呼應呢個 repo 一貫「warnings 而唔係
// 靜靜當 0」原則，見 referral-fee.ts 頂註解）：
//   - 「甩更」（no-show）：schema 冇對應狀態（`ShiftRecordStatus` 淨係
//     draft/pending_approval/confirmed/completed/cancelled，冇「甩更」呢
//     個終態），呢度恆寫 0，唔屈估。
//   - 「其他」（頂更/賣假等 special mark）：`shift_records` 冇獨立欄位
//     記呢類標記（賣假/頂位費喺 `longterm_payroll_inputs` 人手輸入，同
//     單一更冇 1:1 對應），呢度恆留空。
//   - 長工（B07）行「上單價」：任務書明文「系統出實數：月薪÷當月更數，
//     注明」——呢度用「呢個 (盤,更種) B07 組合入面全部長工嘅
//     `guards.monthly_salary` 之和 ÷ 呢個組合嘅總更數」做近似值（跨
//     guard 用曆日比例分攤唔喺呢個粒度做，留喺 longterm-salary.ts 嗰個
//     獨立分攤口徑），口徑說明 sheet 有註明。
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2, monthRange as reportMonthRange, monthLabel } from "./money";
import { buildPayrollTotals, type BrokerPayrollTotal } from "./payroll";
import { computeReferralFeesForMonth, type ComputeReferralFeesResult } from "./referral-fee";
import { buildMonthlyClose } from "./monthly-close";

// ---------------------------------------------------------------------------
// Excel 規則（鐵則）：sheet 名唔可以有 `/ \ ? * [ ] :`（含全形）、長度
// ≤31、唔可以係空字串。呢個 helper 淨係防禦性用（呢個檔用嘅四個 sheet
// 名本身冇犯規），但 export 出嚟俾將來拎去逐盤/逐月生成 sheet 名嘅代碼
// 共用，測試逐一驗證。
// ---------------------------------------------------------------------------
const FORBIDDEN_SHEET_CHARS = /[/\\?*[\]:／＼？＊［］：]/g;

export function sanitizeSheetName(raw: string): string {
  const cleaned = raw.replace(FORBIDDEN_SHEET_CHARS, "-").trim();
  const truncated = cleaned.slice(0, 31);
  return truncated.length > 0 ? truncated : "sheet";
}

/** 避免寫空字串格（鐵則）——冇值就唔賦值，留返真正嘅空 cell。 */
function setCell(ws: ExcelJS.Worksheet, row: number, col: number, value: string | number | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  // 注意：呢度成日都係用 `.value = <literal>` 賦值（string／number），
  // ExcelJS 呢種賦值方式儲存做 str/number cell type，唔會將開頭係 "="
  // 嘅字串當做公式（公式要顯式 `.value = { formula, result }`，呢個
  // 檔全程冇用過），符合鐵則「`=` 開頭字串當文字」。
  ws.getCell(row, col).value = value;
}

export const POSTORDER_SHEET_NAMES = {
  roster: "Roster",
  postOrder: "PostOrder",
  summary: "Summary",
  legend: "口徑說明",
} as const;

// ---------------------------------------------------------------------------
// 資料層：逐 (site, shiftType, settlementBroker) 分組
// ---------------------------------------------------------------------------
interface GroupKey {
  siteId: string;
  shiftTypeId: string;
  brokerId: string | null;
}

interface DayCell {
  siteAlias: string;
  brokerLabel: string;
  note: string | null; // 長工行：安員姓名
  rescueRate: number | null;
  unbilled: boolean;
  guardId: string;
}

interface RosterGroup {
  key: GroupKey;
  siteName: string;
  clientName: string | null;
  shiftLabel: string;
  timeLabel: string | null;
  isLongterm: boolean; // settlementBroker.kind === 'internal_longterm'（B07）
  brokerCode: string;
  brokerLabel: string;
  byDay: Map<number, DayCell[]>; // 1..31
  cancelledCount: number;
  shiftCount: number;
  revenue: number;
  cost: number;
  clientRateSamples: number[];
  guardWageSamples: number[];
  longtermGuardIds: Set<string>;
}

function shortestAlias(canonicalName: string, aliases: string[]): string {
  const candidates = [canonicalName, ...aliases].filter((s) => s && s.length > 0);
  if (candidates.length === 0) return canonicalName;
  return candidates.reduce((shortest, cur) => (cur.length < shortest.length ? cur : shortest));
}

function timeLabel(start: Date | null, end: Date | null): string | null {
  if (!start || !end) return null;
  const fmt = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${fmt(start)}-${fmt(end)}`;
}

/** 眾數（最常出現值）——用嚟做行級代表「上單價」/「外判價」，None 過濾。 */
function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

export interface PostorderBrokerPayout {
  brokerId: string | null;
  brokerCode: string;
  brokerName: string;
  amount: number;
  shifts: number;
}

export interface PostorderSiteRevenue {
  siteId: string;
  siteName: string;
  shifts: number;
  revenue: number;
  cost: number;
}

export interface PostorderWorkbookResult {
  workbook: ExcelJS.Workbook;
  month: string;
  daysInMonth: number;
  rosterRowCount: number;
  brokerPayouts: PostorderBrokerPayout[];
  referralFeeTotal: number;
  siteRevenueTotal: number;
  siteCostTotal: number;
  /** 逐盤（跨全部更種／結算單位加總）——俾 gate script 逐盤對真 Postorder
   * `revenue_site.json`，唔止睇合計。 */
  siteRevenue: PostorderSiteRevenue[];
}

async function loadRosterGroups(month: Date): Promise<{ groups: RosterGroup[]; daysInMonth: number }> {
  const { start, end } = reportMonthRange(month);
  const daysInMonth = end.getUTCDate();

  const records = await prisma.shiftRecord.findMany({
    where: { recordType: "shift", status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    select: {
      workDate: true,
      rescueRate: true,
      clientRateSnapshot: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
      guardId: true,
      guard: { select: { nameZh: true, monthlySalary: true, employmentType: true } },
      site: { select: { id: true, canonicalName: true, aliases: true, clientName: true, guardsPaidByClient: true } },
      shiftType: { select: { id: true, code: true, label: true, startTime: true, endTime: true } },
      settlementBrokerId: true,
      settlementBroker: { select: { id: true, code: true, name: true, kind: true } },
    },
  });

  // 取消格另計（尾欄「取消」）——同上面主查詢分開，狀態唔互斥。
  const cancelled = await prisma.shiftRecord.groupBy({
    by: ["siteId", "shiftTypeId", "settlementBrokerId"],
    where: { recordType: "shift", status: "cancelled", workDate: { gte: start, lte: end } },
    _count: { _all: true },
  });
  const cancelledMap = new Map<string, number>();
  for (const c of cancelled) {
    cancelledMap.set(`${c.siteId}|${c.shiftTypeId}|${c.settlementBrokerId ?? "none"}`, c._count._all);
  }

  const groups = new Map<string, RosterGroup>();
  for (const r of records) {
    const brokerId = r.settlementBrokerId;
    const key = `${r.site.id}|${r.shiftType.id}|${brokerId ?? "none"}`;
    let g = groups.get(key);
    if (!g) {
      const isLongterm = r.settlementBroker?.kind === "internal_longterm";
      const brokerLabel = isLongterm ? "(8) 長工" : (r.settlementBroker?.name ?? "未歸屬結算單位");
      g = {
        key: { siteId: r.site.id, shiftTypeId: r.shiftType.id, brokerId },
        siteName: shortestAlias(r.site.canonicalName, r.site.aliases),
        clientName: r.site.clientName,
        shiftLabel: r.shiftType.label ?? r.shiftType.code,
        timeLabel: timeLabel(r.shiftType.startTime, r.shiftType.endTime),
        isLongterm,
        brokerCode: r.settlementBroker?.code ?? "",
        brokerLabel,
        byDay: new Map(),
        cancelledCount: cancelledMap.get(key) ?? 0,
        shiftCount: 0,
        revenue: 0,
        cost: 0,
        clientRateSamples: [],
        guardWageSamples: [],
        longtermGuardIds: new Set(),
      };
      groups.set(key, g);
    }

    g.shiftCount += 1;
    const clientRate = r.clientRateSnapshot === null ? null : n(r.clientRateSnapshot);
    const guardWage = n(r.guardWageSnapshot);
    const brokerFee = n(r.brokerFeeSnapshot);
    g.revenue = round2(g.revenue + (clientRate ?? 0));
    g.cost = round2(g.cost + guardWage + brokerFee);
    if (clientRate !== null) g.clientRateSamples.push(clientRate);
    if (r.guardWageSnapshot !== null) g.guardWageSamples.push(guardWage);
    if (g.isLongterm) g.longtermGuardIds.add(r.guardId);

    const day = r.workDate.getUTCDate();
    const cell: DayCell = {
      siteAlias: g.siteName,
      brokerLabel: g.brokerLabel,
      note: g.isLongterm ? (r.guard.nameZh ?? null) : null,
      rescueRate: r.rescueRate === null ? null : n(r.rescueRate),
      unbilled: clientRate === null || r.site.guardsPaidByClient,
      guardId: r.guardId,
    };
    const list = g.byDay.get(day);
    if (list) list.push(cell);
    else g.byDay.set(day, [cell]);
  }

  return { groups: [...groups.values()], daysInMonth };
}

// ---------------------------------------------------------------------------
// Roster sheet
// ---------------------------------------------------------------------------
const ROSTER_DAY_SUBCOLS = ["日期", "雞頭", "備註", "其他", "救更價", "Unbilled", "Paid"] as const;
const ROSTER_TAIL_COLS = ["取消", "甩更", "當月更數", "當月收入", "當月成本", "當月GP"] as const;

async function writeRosterSheet(
  wb: ExcelJS.Workbook,
  groups: RosterGroup[],
  daysInMonth: number,
  monthLocked: boolean,
  longtermMonthlySalaryByGuard: Map<string, number>,
): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.roster));

  const head = ["客戶名稱", "物業名稱", "更份/時段", "上單價", "外判價", "時間"];
  for (let d = 1; d <= daysInMonth; d++) for (const sub of ROSTER_DAY_SUBCOLS) head.push(`${d}日 ${sub}`);
  head.push(...ROSTER_TAIL_COLS);
  head.forEach((h, i) => setCell(ws, 1, i + 1, h));

  let row = 2;
  for (const g of groups) {
    let col = 1;
    setCell(ws, row, col++, g.clientName);
    setCell(ws, row, col++, g.siteName);
    setCell(ws, row, col++, g.shiftLabel);

    let clientRateRepr: number | null;
    if (g.isLongterm) {
      let salarySum = 0;
      for (const guardId of g.longtermGuardIds) salarySum += longtermMonthlySalaryByGuard.get(guardId) ?? 0;
      clientRateRepr = g.shiftCount > 0 ? round2(salarySum / g.shiftCount) : null;
    } else {
      clientRateRepr = mode(g.clientRateSamples);
    }
    setCell(ws, row, col++, clientRateRepr);
    setCell(ws, row, col++, g.isLongterm ? null : mode(g.guardWageSamples));
    setCell(ws, row, col++, g.timeLabel);

    for (let d = 1; d <= daysInMonth; d++) {
      const cells = g.byDay.get(d);
      if (cells && cells.length > 0) {
        const first = cells[0];
        setCell(ws, row, col, first.siteAlias);
        setCell(ws, row, col + 1, first.brokerLabel);
        setCell(
          ws,
          row,
          col + 2,
          cells
            .map((c) => c.note)
            .filter((x): x is string => !!x)
            .join("、") || null,
        );
        // 「其他」（頂更/賣假等）：schema 冇對應欄，恆留空（見檔頭註解）。
        const rescueRates = cells.map((c) => c.rescueRate).filter((x): x is number => x !== null);
        setCell(ws, row, col + 4, rescueRates.length > 0 ? round2(rescueRates.reduce((a, b) => a + b, 0)) : null);
        setCell(ws, row, col + 5, cells.some((c) => c.unbilled) ? 1 : null);
        setCell(ws, row, col + 6, monthLocked ? 1 : null);
      }
      col += 7;
    }

    setCell(ws, row, col++, g.cancelledCount > 0 ? g.cancelledCount : null);
    setCell(ws, row, col++, 0); // 甩更：schema 未追蹤，恆 0（見檔頭註解）
    setCell(ws, row, col++, g.shiftCount);
    setCell(ws, row, col++, g.revenue);
    setCell(ws, row, col++, g.cost);
    setCell(ws, row, col++, round2(g.revenue - g.cost));
    row++;
  }

  ws.getRow(1).font = { bold: true };
  ws.getColumn(2).width = 20;
}

// ---------------------------------------------------------------------------
// PostOrder sheet：同 Roster 逐行對應嘅精簡版＋長工雞頭費
// ---------------------------------------------------------------------------
async function writePostOrderSheet(
  wb: ExcelJS.Workbook,
  groups: RosterGroup[],
  daysInMonth: number,
  referral: ComputeReferralFeesResult,
  brokerNameById: Map<string, string>,
  siteNameById: Map<string, string>,
): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.postOrder));

  const head = ["物業名稱", "更份/時段", "結算單位"];
  for (let d = 1; d <= daysInMonth; d++) head.push(`${d}日`);
  head.push("Total Shift");
  head.forEach((h, i) => setCell(ws, 1, i + 1, h));

  let row = 2;
  for (const g of groups) {
    let col = 1;
    setCell(ws, row, col++, g.siteName);
    setCell(ws, row, col++, g.shiftLabel);
    setCell(ws, row, col++, g.brokerLabel);
    for (let d = 1; d <= daysInMonth; d++) {
      const cells = g.byDay.get(d);
      setCell(ws, row, col, cells && cells.length > 0 ? cells[0].siteAlias : null);
      col++;
    }
    setCell(ws, row, col++, g.shiftCount);
    row++;
  }

  row += 2;
  setCell(ws, row, 1, "長工雞頭費 (雞頭)");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, "雞頭");
  setCell(ws, row, 2, "盤");
  setCell(ws, row, 3, "費率");
  setCell(ws, row, 4, "更數");
  setCell(ws, row, 5, "金額");
  ws.getRow(row).font = { bold: true };
  row++;

  // 逐雞頭逐盤匯總（referral-fee.ts 純函數已經逐 (broker,guard,site) 計
  // 好，呢度按 (broker,site) 加埋——Postorder 總表只顯示到盤一級，唔顯示
  // 個別安員）。
  const byBrokerSite = new Map<string, { brokerId: string; siteId: string; shifts: number; amount: number; feePerShift: number }>();
  for (const li of referral.lineItems) {
    const k = `${li.brokerId}|${li.siteId}`;
    const cur = byBrokerSite.get(k);
    if (cur) {
      cur.shifts += li.shifts;
      cur.amount = round2(cur.amount + li.amount);
    } else {
      byBrokerSite.set(k, { brokerId: li.brokerId, siteId: li.siteId, shifts: li.shifts, amount: li.amount, feePerShift: li.feePerShift });
    }
  }
  for (const item of byBrokerSite.values()) {
    setCell(ws, row, 1, brokerNameById.get(item.brokerId) ?? item.brokerId);
    setCell(ws, row, 2, siteNameById.get(item.siteId) ?? item.siteId);
    setCell(ws, row, 3, item.feePerShift);
    setCell(ws, row, 4, item.shifts);
    setCell(ws, row, 5, item.amount);
    row++;
  }

  ws.getRow(1).font = { bold: true };
  ws.getColumn(1).width = 20;
}

// ---------------------------------------------------------------------------
// Summary sheet
// ---------------------------------------------------------------------------
async function writeSummarySheet(wb: ExcelJS.Workbook, month: Date, payrollTotals: BrokerPayrollTotal[], referral: ComputeReferralFeesResult): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.summary));
  const { start, end } = reportMonthRange(month);
  const mid = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 15));

  let row = 1;
  setCell(ws, row, 1, `Postorder 總表 — ${monthLabel(month)}`);
  ws.getRow(row).font = { bold: true, size: 14 };
  row += 2;

  // 逐雞頭付款（SUMIF 語意：Σ外判價 by 結算單位）——直接重用
  // `buildPayrollTotals()`（同 `gate:reports`/`gate:pricing` 已經對過數
  // 嘅同一條 pure function，唔重新發明公式）。
  setCell(ws, row, 1, "逐雞頭付款");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, "雞頭代碼");
  setCell(ws, row, 2, "雞頭名稱");
  setCell(ws, row, 3, "更數");
  setCell(ws, row, 4, "外判價小計");
  setCell(ws, row, 5, "雞頭費小計");
  setCell(ws, row, 6, "合計");
  ws.getRow(row).font = { bold: true };
  row++;
  let payoutTotal = 0;
  for (const t of payrollTotals) {
    setCell(ws, row, 1, t.brokerCode || "—");
    setCell(ws, row, 2, t.brokerName);
    setCell(ws, row, 3, t.shifts);
    setCell(ws, row, 4, t.wage);
    setCell(ws, row, 5, t.fee);
    setCell(ws, row, 6, t.amount);
    payoutTotal = round2(payoutTotal + t.amount);
    row++;
  }
  setCell(ws, row, 2, "合計");
  setCell(ws, row, 6, payoutTotal);
  ws.getRow(row).font = { bold: true };
  row += 2;

  // 半月結 01-15 / 16-31——同 buildPayrollTotals() 一致嘅 where 條件，
  // 淨係加返日期上下限（呢度冧一次獨立查詢，因為 buildPayrollTotals()
  // 冇拆半月參數）。
  setCell(ws, row, 1, "半月結");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, "雞頭代碼");
  setCell(ws, row, 2, "01-15 合計");
  setCell(ws, row, 3, "16-31 合計");
  ws.getRow(row).font = { bold: true };
  row++;
  const brokers = await prisma.broker.findMany({ orderBy: { code: "asc" } });
  for (const b of brokers) {
    const [firstHalf, secondHalf] = await Promise.all([
      prisma.shiftRecord.aggregate({
        where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: mid }, status: { not: "cancelled" } },
        _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
      }),
      prisma.shiftRecord.aggregate({
        where: { settlementBrokerId: b.id, recordType: { in: ["shift", "ot"] }, workDate: { gt: mid, lte: end }, status: { not: "cancelled" } },
        _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
      }),
    ]);
    const firstAmt = round2(n(firstHalf._sum.guardWageSnapshot) + n(firstHalf._sum.brokerFeeSnapshot));
    const secondAmt = round2(n(secondHalf._sum.guardWageSnapshot) + n(secondHalf._sum.brokerFeeSnapshot));
    if (firstAmt === 0 && secondAmt === 0) continue;
    setCell(ws, row, 1, b.code);
    setCell(ws, row, 2, firstAmt);
    setCell(ws, row, 3, secondAmt);
    row++;
  }
  row += 1;

  // 介紹費
  setCell(ws, row, 1, "介紹費（長工雞頭費）");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, `合計：${referral.totalAmount}（${referral.lineItems.length} 行；卓弘豁免 ${referral.exemptShiftCount} 格；${referral.warnings.length} 個組合冇費率未計入）`);
  row += 2;

  // K passthrough 提示（規則 12：系統外現金扣，唔扣）
  setCell(
    ws,
    row,
    1,
    "提示（§14 規則 12）：簽證形式長工每月 Autopay＋MPF ER 由公司支付維持簽證，但喺對應雞頭結算（大糧）現金扣返俾公司——呢筆扣減唔喺呢張總表反映（總表雞頭數字係扣減前金額），會計出糧後系統外現金扣。",
  );
  row += 2;

  // 長工 Autopay/MPF
  const ltRun = await prisma.longtermPayrollRun.findFirst({ where: { month: start, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
  setCell(ws, row, 1, "長工糧（Autopay／MPF）");
  ws.getRow(row).font = { bold: true };
  row++;
  if (ltRun && ltRun.totalsJson) {
    const t = ltRun.totalsJson as unknown as { grossTotal?: number; autopayTotal?: number; mpfEeTotal?: number; mpfErTotal?: number; guardCount?: number };
    setCell(ws, row, 1, "Gross");
    setCell(ws, row, 2, n(t.grossTotal));
    row++;
    setCell(ws, row, 1, "Autopay");
    setCell(ws, row, 2, n(t.autopayTotal));
    row++;
    setCell(ws, row, 1, "MPF 僱員 (EE)");
    setCell(ws, row, 2, n(t.mpfEeTotal));
    row++;
    setCell(ws, row, 1, "MPF 僱主 (ER)");
    setCell(ws, row, 2, n(t.mpfErTotal));
    row++;
    setCell(ws, row, 1, "人數");
    setCell(ws, row, 2, t.guardCount ?? 0);
    row++;
  } else {
    setCell(ws, row, 1, "（本月未計長工糧——未有 longterm_payroll_runs run，先喺長工糧頁「重算本月」）");
    row++;
  }
  row += 1;

  // 總收入/總成本/毛利（合併口徑，同 monthly-close.ts combinedCostSummary 一致）
  const { mainRows, combinedCostSummary } = await buildMonthlyClose(month);
  const revenue = round2(mainRows.reduce((a, r) => a + r.revenue, 0));
  const perShiftCost = round2(mainRows.reduce((a, r) => a + r.cost, 0));
  setCell(ws, row, 1, "總收入／總成本／毛利（合併口徑）");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, "營業額（主表）");
  setCell(ws, row, 2, revenue);
  row++;
  setCell(ws, row, 1, "更次成本（散工×出街價）");
  setCell(ws, row, 2, perShiftCost);
  row++;
  if (combinedCostSummary) {
    setCell(ws, row, 1, "介紹費");
    setCell(ws, row, 2, combinedCostSummary.referralFeeTotal);
    row++;
    setCell(ws, row, 1, "長工 Autopay（已剔簽證形式）");
    setCell(ws, row, 2, combinedCostSummary.longtermAutopayTotal);
    row++;
    setCell(ws, row, 1, "合併成本合計");
    setCell(ws, row, 2, combinedCostSummary.combinedCostTotal);
    row++;
    setCell(ws, row, 1, "毛利（營業額－合併成本）");
    setCell(ws, row, 2, round2(revenue - combinedCostSummary.combinedCostTotal));
    row++;
  } else {
    setCell(ws, row, 1, "毛利（營業額－更次成本，7 月前口徑，未含長工 Autopay/介紹費）");
    setCell(ws, row, 2, round2(revenue - perShiftCost));
    row++;
  }

  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
}

async function writeLegendSheet(wb: ExcelJS.Workbook, month: Date): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.legend));
  const lines: Array<string> = [
    `Postorder 格式總表 — 口徑說明（§20.4 Phase 4，系統輸出，${monthLabel(month)}）`,
    "",
    "資料來源：shift_records（非 cancelled）＋ rate_cards snapshot（寫喺 shift_records 上嘅 client_rate_snapshot/guard_wage_snapshot/broker_fee_snapshot）＋ special_items（介紹費）＋ longterm_payroll_runs（長工糧）。",
    "",
    "Roster／PostOrder 逐行 = 一個 (盤, 更種/時段, 結算單位) 組合，唔係逐個安員一行。",
    "日期格「盤簡稱」= sites.aliases 入面最短嗰個，冇 aliases 就用 canonicalName。",
    "雞頭名：brokers.name；結算單位 kind=internal_longterm（B07）恆寫「(8) 長工」（呢個 broker 喺 DB name 本身係佔位符 \"B07\"）。",
    "備註：長工行寫安員姓名（來自 guards.name_zh）；散工雞頭行留空。",
    "其他：頂更/賣假等 special mark——schema 未有對應欄位追蹤單一更嘅呢類標記，恆留空（唔屈估）。",
    "救更價：shift_records.rescue_rate（有值先寫）。",
    "Unbilled：client_rate_snapshot 為 null，或者呢個盤 sites.guards_paid_by_client=true（LINK 客戶自己出糧）→ 1；其餘留空。",
    "Paid：month_closes 該月已鎖定（locked_at 非 null）→ 1；未鎖定留空。",
    "取消：該 (盤,更種,結算單位) 組合本月 status=cancelled 嘅記錄數。",
    "甩更：schema 冇對應終態（ShiftRecordStatus 冇「甩更」值），恆 0——如老闆要追蹤呢個概念，要先喺 shift_records 加狀態/欄位。",
    "長工（B07）行「上單價」：任務書明文「系統出實數：月薪÷當月更數，注明」——呢度＝該 (盤,更種) B07 組合入面全部出過更嘅長工 guards.monthly_salary 之和 ÷ 該組合當月更數（近似值，唔係逐人按曆日比例分攤——嗰個口徑喺 longterm-salary.ts 獨立處理，用喺月結總表「長工月薪分攤」欄）。",
    "",
    "Summary「逐雞頭付款」＝ buildPayrollTotals()（src/lib/reports/payroll.ts）——同 gate:reports／gate:pricing 已經對過數嘅同一條 pure function，唔重新發明公式。",
    "Summary「介紹費」＝ computeReferralFeesForMonth()（src/lib/reports/referral-fee.ts）——§19.1 長工介紹雞頭 fallback 邏輯（唔靠 Postorder 上載）。",
    "Summary「長工 Autopay/MPF」＝ 該月最新一個未作廢 longterm_payroll_runs.totals_json。",
    "Summary「總收入/總成本/毛利」＝ buildMonthlyClose() combinedCostSummary（同月結頁/一鍵結算報告同一口徑）。",
    "",
    "§14 規則 12（簽證形式長工 salary passthrough）：呢個系統外現金扣減唔喺任何數字反映，總表雞頭數字係扣減前金額——見 Summary 提示行。",
    "§14 規則 12a（卓弘豁免介紹費）：由 2026-09 起生效，8 月結算跟月結表全數支付。",
    "",
    "已知差異項目（§19，8 月驗收時記錄，未必每月都出現，出現時要人手核對）：Event 分盤、OT 記錄未折入日曆格、蔚峰園(W)更表重複行、凱和山 Unbilled 判斷、CP5 IC proxy。呢啲屬於*上游更表資料*本身嘅已知落差，唔係呢個 export 模組嘅 bug——見 scripts/gate/postorder-export-aug.ts 差異表。",
  ];
  lines.forEach((l, i) => setCell(ws, i + 1, 1, l));
  ws.getColumn(1).width = 100;
}

export async function buildPostorderWorkbook(month: Date): Promise<PostorderWorkbookResult> {
  const wb = new ExcelJS.Workbook();
  const { groups, daysInMonth } = await loadRosterGroups(month);

  const [payrollTotals, referral, monthClose, brokers, sites] = await Promise.all([
    buildPayrollTotals(month),
    computeReferralFeesForMonth(month),
    prisma.monthClose.findUnique({ where: { month: reportMonthRange(month).start }, select: { lockedAt: true } }),
    prisma.broker.findMany({ select: { id: true, name: true } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true } }),
  ]);
  const brokerNameById = new Map(brokers.map((b) => [b.id, b.name]));
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));

  const longtermGuardIds = new Set<string>();
  for (const g of groups) for (const id of g.longtermGuardIds) longtermGuardIds.add(id);
  const longtermGuards =
    longtermGuardIds.size > 0 ? await prisma.guard.findMany({ where: { id: { in: [...longtermGuardIds] } }, select: { id: true, monthlySalary: true } }) : [];
  const longtermMonthlySalaryByGuard = new Map(longtermGuards.map((g) => [g.id, n(g.monthlySalary)]));

  await writeRosterSheet(wb, groups, daysInMonth, !!monthClose?.lockedAt, longtermMonthlySalaryByGuard);
  await writePostOrderSheet(wb, groups, daysInMonth, referral, brokerNameById, siteNameById);
  await writeSummarySheet(wb, month, payrollTotals, referral);
  await writeLegendSheet(wb, month);

  const siteRevenueTotal = round2(groups.reduce((a, g) => a + g.revenue, 0));
  const siteCostTotal = round2(groups.reduce((a, g) => a + g.cost, 0));

  const siteRevenueBySite = new Map<string, PostorderSiteRevenue>();
  for (const g of groups) {
    const cur = siteRevenueBySite.get(g.key.siteId);
    if (cur) {
      cur.shifts += g.shiftCount;
      cur.revenue = round2(cur.revenue + g.revenue);
      cur.cost = round2(cur.cost + g.cost);
    } else {
      siteRevenueBySite.set(g.key.siteId, { siteId: g.key.siteId, siteName: siteNameById.get(g.key.siteId) ?? g.siteName, shifts: g.shiftCount, revenue: g.revenue, cost: g.cost });
    }
  }

  return {
    workbook: wb,
    month: monthLabel(month),
    daysInMonth,
    rosterRowCount: groups.length,
    brokerPayouts: payrollTotals.map((t) => ({ brokerId: t.brokerId, brokerCode: t.brokerCode, brokerName: t.brokerName, amount: t.amount, shifts: t.shifts })),
    referralFeeTotal: referral.totalAmount,
    siteRevenueTotal,
    siteCostTotal,
    siteRevenue: [...siteRevenueBySite.values()],
  };
}

export async function writePostorderXlsx(outPath: string, month: Date): Promise<PostorderWorkbookResult> {
  const result = await buildPostorderWorkbook(month);
  await result.workbook.xlsx.writeFile(outPath);
  return result;
}
