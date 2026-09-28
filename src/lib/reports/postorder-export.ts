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
//   - 長工（B07）行：真 Postorder 呢類行「上單價」(E) 照寫收客價，
//     「外判價」(F) 係 `#REF!`（月薪÷更數公式斷咗）——任務書明文「系統出
//     實數：月薪÷當月更數，注明」，所以呢度「上單價」＝收客價眾數（同散工
//     行一樣），「外判價」＝(呢行每位長工月薪 × 佢喺呢行嘅更數÷佢本月 B07
//     總更數) 之和 ÷ 呢行更數——一位長工一行做足全月＝月薪÷當月更數；
//     同一人分散幾行就按更數比例拆，唔會重複計足幾次月薪。月薪來源：
//     本月生效嘅 `guard_longterm_contracts`（日薪制＝`daily_rate` 直接當
//     每更），冇合約先 fallback `guards.monthly_salary`。（Opus 5.5 驗收
//     2026-09-27 修正：原版將月薪÷更數寫落「上單價」欄、而且同一人喺幾
//     行各計足一次月薪。）
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2, monthRange as reportMonthRange, monthLabel } from "./money";
import { buildPayrollTotals, type BrokerPayrollTotal } from "./payroll";
import { computeReferralFeesForMonth, type ComputeReferralFeesResult } from "./referral-fee";
import { buildMonthlyClose } from "./monthly-close";
import { buildGrossMargin } from "./gross-margin";

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
  /** WP-BOSS5 §25.7（老闆 2026-09-28 追加決定 #7）：呢個組係咪 OT 行
   * （record_type='ot'）——同一 (盤, OT 更種, 結算雞頭) 一組，同散工/長工
   * 正更組獨立（OT 更種本身就係一個獨立 shiftTypeId，key 自然分開）。
   * OT 行「更數」＝Σ ot_hours（老闆「折入」：以小時做更數，配合決定 #1
   * 每小時价），唔係逐格 +1。 */
  isOt: boolean;
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
  /** B07 行逐安員更數——外判價（月薪按更數比例拆）用。 */
  longtermShiftsByGuard: Map<string, number>;
  /** 排序用：物業顯示名＋真盤名（Event 盤排喺母盤後面）。 */
  sortKey: string;
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
  revenue: number; // 含 OT（WP-BOSS5 §25.7）
  cost: number;
  /** WP-BOSS5 §25.7：呢個盤 OT 行嘅收入／更數（Σ ot_hours）子集——已經
   * 摺入 `revenue`/`shifts`，呢兩個欄淨係俾 caller 想拆走 OT 部分（例如
   * 對比 `buildMonthlyClose()` P0 口徑唔含 OT）用。 */
  otRevenue: number;
  otShifts: number;
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
  /** Summary 總收入／成本／毛利（同一鍵結算報告同一口徑）。 */
  summaryTotals: PostorderSummaryTotals;
}

async function loadRosterGroups(month: Date): Promise<{ groups: RosterGroup[]; daysInMonth: number }> {
  const { start, end } = reportMonthRange(month);
  const daysInMonth = end.getUTCDate();

  // WP-BOSS5 §25.7（老闆 2026-09-28 追加決定 #7）：OT（record_type='ot'）
  // 都要折入 Roster／PostOrder（同一 (盤, OT 更種, 結算雞頭) 一組，OT 更種
  // 本身就係獨立 shiftTypeId，group key 自然同正更分開）。
  const records = await prisma.shiftRecord.findMany({
    where: { recordType: { in: ["shift", "ot"] }, status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    select: {
      workDate: true,
      rescueRate: true,
      clientRateSnapshot: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
      guardId: true,
      recordType: true,
      otHours: true,
      guard: { select: { nameZh: true, monthlySalary: true, employmentType: true } },
      site: { select: { id: true, canonicalName: true, aliases: true, clientName: true, guardsPaidByClient: true } },
      shiftType: { select: { id: true, code: true, label: true, startTime: true, endTime: true } },
      settlementBrokerId: true,
      settlementBroker: { select: { id: true, code: true, name: true, kind: true } },
    },
  });

  // 取消格另計（尾欄「取消」）——同上面主查詢分開，狀態唔互斥；OT 都計
  // （§25.7 之後 OT 行都喺 Roster 出現，取消格數都應該跟埋）。
  const cancelled = await prisma.shiftRecord.groupBy({
    by: ["siteId", "shiftTypeId", "settlementBrokerId"],
    where: { recordType: { in: ["shift", "ot"] }, status: "cancelled", workDate: { gte: start, lte: end } },
    _count: { _all: true },
  });
  const cancelledMap = new Map<string, number>();
  for (const c of cancelled) {
    cancelledMap.set(`${c.siteId}|${c.shiftTypeId}|${c.settlementBrokerId ?? "none"}`, c._count._all);
  }

  // Event 分盤（例：「啟航1331 Event」）——系統係獨立盤（獨立價卡），但老闆
  // 真 Postorder 將 Event 行放喺母盤 block 入面（物業名稱同母盤一樣寫「啟航」，
  // 客戶欄寫「… Event」）。呢度跟返老闆習慣：物業名稱用母盤簡稱、更份
  // 前面加「Event」，行排喺母盤後面；**逐行收入／成本唔合併**（逐盤加總仍然
  // 同月結總表逐盤一致，Event 盤自己一個 siteId）。
  const allSites = await prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } });
  const siteByName = new Map(allSites.map((s) => [s.canonicalName, s]));
  const eventParentAlias = new Map<string, string>();
  for (const s of allSites) {
    const m = /^(.+?)\s+Event$/.exec(s.canonicalName);
    const parent = m ? siteByName.get(m[1]) : undefined;
    if (parent) eventParentAlias.set(s.id, shortestAlias(parent.canonicalName, parent.aliases));
  }

  const groups = new Map<string, RosterGroup>();
  for (const r of records) {
    const brokerId = r.settlementBrokerId;
    const key = `${r.site.id}|${r.shiftType.id}|${brokerId ?? "none"}`;
    const isOt = r.recordType === "ot";
    let g = groups.get(key);
    if (!g) {
      const isLongterm = r.settlementBroker?.kind === "internal_longterm";
      const brokerLabel = isLongterm ? "(8) 長工" : (r.settlementBroker?.name ?? "未歸屬結算單位");
      const eventAlias = eventParentAlias.get(r.site.id);
      const displaySite = eventAlias ?? shortestAlias(r.site.canonicalName, r.site.aliases);
      const baseShiftLabel = r.shiftType.label ?? r.shiftType.code;
      const shiftLabel = eventAlias ? `Event ${baseShiftLabel}` : baseShiftLabel;
      g = {
        key: { siteId: r.site.id, shiftTypeId: r.shiftType.id, brokerId },
        siteName: displaySite,
        clientName: r.site.clientName,
        shiftLabel,
        timeLabel: timeLabel(r.shiftType.startTime, r.shiftType.endTime),
        isLongterm,
        isOt,
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
        longtermShiftsByGuard: new Map(),
        sortKey: [displaySite, r.site.canonicalName, isLongterm ? "1" : "0", shiftLabel, timeLabel(r.shiftType.startTime, r.shiftType.endTime) ?? "", r.settlementBroker?.code ?? "~"].join("\u0001"),
      };
      groups.set(key, g);
    }

    // §25.7：OT 行「更數」＝Σ ot_hours（老闆「折入」決定：以小時做更數，
    // 配合 §25.1 OT 卡＝每小時价）；正更／請假照舊逐格 +1。冇 ot_hours
    // （未定价 OT）＝呢格對「更數」貢獻 0（唔屈估，同 gross-margin.ts
    // 8 月起「冇 hours 唔可以估」呼應）。
    const otH = isOt ? (r.otHours === null ? 0 : n(r.otHours)) : 0;
    const countIncrement = isOt ? otH : 1;
    g.shiftCount = round2(g.shiftCount + countIncrement);
    const clientRate = r.clientRateSnapshot === null ? null : n(r.clientRateSnapshot);
    const guardWage = n(r.guardWageSnapshot);
    const brokerFee = n(r.brokerFeeSnapshot);
    // §25.1 之後 OT snapshot 已經係「呢條記錄嘅金額」（卡金額×otHours 喺
    // resolve-rate.ts 寫入嗰刻已經計好），呢度加總唔使再乘 otHours。
    g.revenue = round2(g.revenue + (clientRate ?? 0));
    g.cost = round2(g.cost + guardWage + brokerFee);
    // 「上單價」／「外判價」樣本：OT 行要顯示每小時价（snapshot÷otHours），
    // 唔係嗰粒 OT 記錄嘅總金額；正更／長工行樣本照舊用記錄本身金額。
    if (isOt) {
      if (clientRate !== null && otH > 0) g.clientRateSamples.push(round2(clientRate / otH));
      if (r.guardWageSnapshot !== null && otH > 0) g.guardWageSamples.push(round2(guardWage / otH));
    } else {
      if (clientRate !== null) g.clientRateSamples.push(clientRate);
      if (r.guardWageSnapshot !== null) g.guardWageSamples.push(guardWage);
    }
    if (g.isLongterm) {
      g.longtermGuardIds.add(r.guardId);
      g.longtermShiftsByGuard.set(r.guardId, (g.longtermShiftsByGuard.get(r.guardId) ?? 0) + countIncrement);
    }

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

  const sorted = [...groups.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return { groups: sorted, daysInMonth };
}

/** 長工每人「每月成本基準」：本月生效合約（月薪制＝月薪；日薪制＝每更價），
 * 冇合約 fallback `guards.monthly_salary`。 */
type LongtermPayBasisInfo = { kind: "monthly"; monthlySalary: number } | { kind: "daily"; dailyRate: number };

/** 外判價（長工行）：Σ(每位長工月薪 × 佢喺呢行更數 ÷ 佢本月 B07 總更數) ÷ 呢行更數；
 * 日薪制直接用每更價。純函數，export 俾測試。 */
export function longtermRowPayoutRate(
  shiftsByGuard: Map<string, number>,
  totalB07ShiftsByGuard: Map<string, number>,
  payBasisByGuard: Map<string, LongtermPayBasisInfo>,
): number | null {
  let rowShifts = 0;
  let cost = 0;
  let known = false;
  for (const [guardId, shifts] of shiftsByGuard) {
    rowShifts += shifts;
    const basis = payBasisByGuard.get(guardId);
    if (!basis) continue;
    known = true;
    if (basis.kind === "daily") cost += basis.dailyRate * shifts;
    else {
      const total = totalB07ShiftsByGuard.get(guardId) ?? shifts;
      cost += total > 0 ? (basis.monthlySalary * shifts) / total : 0;
    }
  }
  if (!known || rowShifts === 0) return null;
  return round2(cost / rowShifts);
}

/** 盤級收入補差行（月費／admin_fee／special billing，或者月結口徑調整）。 */
interface FlatRevenueRow {
  siteId: string;
  siteName: string;
  clientName: string | null;
  amount: number;
  label: "月費" | "收入調整（月結口徑）";
}

/** 逐行次序：散工／長工行按盤排好，每個盤最後一行之後即刻跟返嗰個盤嘅
 * 「月費／收入調整」行（同一盤 block 入面），冇逐更行嘅盤放最尾。 */
type RowItem = { kind: "group"; g: RosterGroup } | { kind: "flat"; r: FlatRevenueRow };
function interleaveRows(groups: RosterGroup[], flatRows: FlatRevenueRow[]): RowItem[] {
  const flatBySite = new Map<string, FlatRevenueRow[]>();
  for (const r of flatRows) flatBySite.set(r.siteId, [...(flatBySite.get(r.siteId) ?? []), r]);
  const out: RowItem[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    out.push({ kind: "group", g });
    const next = groups[i + 1];
    if (!next || next.key.siteId !== g.key.siteId) {
      for (const r of flatBySite.get(g.key.siteId) ?? []) out.push({ kind: "flat", r });
      flatBySite.delete(g.key.siteId);
    }
  }
  for (const rows of flatBySite.values()) for (const r of rows) out.push({ kind: "flat", r });
  return out;
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
  longtermPayoutRate: (g: RosterGroup) => number | null,
  flatRevenueRows: FlatRevenueRow[],
): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.roster));

  const head = ["客戶名稱", "物業名稱", "更份/時段", "上單價", "外判價", "時間"];
  for (let d = 1; d <= daysInMonth; d++) for (const sub of ROSTER_DAY_SUBCOLS) head.push(`${d}日 ${sub}`);
  head.push(...ROSTER_TAIL_COLS);
  head.forEach((h, i) => setCell(ws, 1, i + 1, h));

  let row = 2;
  for (const item of interleaveRows(groups, flatRevenueRows)) {
    if (item.kind === "flat") {
      const r = item.r;
      let col = 1;
      setCell(ws, row, col++, r.clientName);
      setCell(ws, row, col++, r.siteName);
      setCell(ws, row, col++, r.label);
      setCell(ws, row, col++, r.amount);
      col += 2; // 外判價／時間留空
      col += daysInMonth * 7; // 日曆 block 留空（月費唔逐更）
      col += 2; // 取消／甩更留空
      setCell(ws, row, col++, 0);
      setCell(ws, row, col++, r.amount);
      setCell(ws, row, col++, 0);
      setCell(ws, row, col++, r.amount);
      row++;
      continue;
    }
    const g = item.g;
    let col = 1;
    setCell(ws, row, col++, g.clientName);
    setCell(ws, row, col++, g.siteName);
    setCell(ws, row, col++, g.shiftLabel);

    // 上單價＝收客價眾數（長工行都一樣，真 Postorder E 欄）；外判價：散工
    // 行＝出街價眾數，長工行＝月薪÷當月更數（真 Postorder F 欄 `#REF!`，
    // 見檔頭註解）。
    setCell(ws, row, col++, mode(g.clientRateSamples));
    setCell(ws, row, col++, g.isLongterm ? longtermPayoutRate(g) : mode(g.guardWageSamples));
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
  flatRevenueRows: FlatRevenueRow[],
): Promise<void> {
  const ws = wb.addWorksheet(sanitizeSheetName(POSTORDER_SHEET_NAMES.postOrder));

  const head = ["物業名稱", "更份/時段", "結算單位"];
  for (let d = 1; d <= daysInMonth; d++) head.push(`${d}日`);
  head.push("Total Shift");
  head.forEach((h, i) => setCell(ws, 1, i + 1, h));

  let row = 2;
  for (const item of interleaveRows(groups, flatRevenueRows)) {
    if (item.kind === "flat") {
      const r = item.r;
      let col = 1;
      setCell(ws, row, col++, r.siteName);
      setCell(ws, row, col++, r.label);
      setCell(ws, row, col++, "—");
      col += daysInMonth; // 日曆留空
      setCell(ws, row, col++, 0);
      row++;
      continue;
    }
    const g = item.g;
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
    // 驗收：key 包埋費率——同一 (雞頭,盤) 有唔同費率嘅人唔可以合埋一行
    // 淨顯示第一個費率（會令「費率×更數≠金額」掩蓋差異）。
    const k = `${li.brokerId}|${li.siteId}|${li.feePerShift}`;
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
async function writeSummarySheet(
  wb: ExcelJS.Workbook,
  month: Date,
  payrollTotals: BrokerPayrollTotal[],
  referral: ComputeReferralFeesResult,
  monthlyClose: Awaited<ReturnType<typeof buildMonthlyClose>>,
  grossMargin: Awaited<ReturnType<typeof buildGrossMargin>>,
  otRevenueTotal: number,
): Promise<PostorderSummaryTotals> {
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
  const ltRun = await prisma.longtermPayrollRun.findFirst({ where: { month: start, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
  setCell(
    ws,
    row,
    1,
    "提示（§14 規則 12）：簽證形式長工每月人工（Gross）＋MPF 僱主供款由公司支付維持簽證，但喺對應雞頭結算（大糧）現金扣返俾公司——呢筆扣減唔喺呢張總表反映（上面逐雞頭付款係扣減前金額），會計出糧後系統外現金扣。",
  );
  row++;
  if (ltRun) {
    // 逐雞頭列出參考金額（長工糧 run 逐人 line，唔帶姓名）。
    const visaLines = await prisma.longtermPayrollLine.findMany({
      where: { runId: ltRun.id, guard: { visaSponsoredByBrokerId: { not: null } } },
      select: { gross: true, mpfEr: true, guard: { select: { visaSponsoredByBroker: { select: { code: true } } } } },
    });
    const byBroker = new Map<string, { count: number; gross: number; mpfEr: number }>();
    for (const l of visaLines) {
      const code = l.guard.visaSponsoredByBroker?.code ?? "—";
      const cur = byBroker.get(code) ?? { count: 0, gross: 0, mpfEr: 0 };
      cur.count++;
      cur.gross = round2(cur.gross + n(l.gross));
      cur.mpfEr = round2(cur.mpfEr + n(l.mpfEr));
      byBroker.set(code, cur);
    }
    for (const [code, v] of byBroker) {
      setCell(ws, row, 1, `  雞頭 ${code}：簽證形式長工 ${v.count} 人，人工 Gross ${v.gross}＋MPF ER ${v.mpfEr}＝${round2(v.gross + v.mpfEr)}（參考金額，會計喺呢個雞頭大糧現金扣返，系統外）`);
      row++;
    }
  }
  row++;

  // 長工 Autopay/MPF
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

  // 總收入/總成本/毛利——**同一鍵結算報告 `stepCompute()`（src/lib/month-
  // close/one-click.ts）一模一樣嘅口徑**（Opus 5.5 驗收修正：原版用
  // `buildMonthlyClose()` 主表營業額＋月結 combinedCostSummary，同一鍵報告
  // 差 84.85／73／11.85，而且冇「月結以外」收入）：
  //   總收入＝月結總表主表＋月結以外（`buildMonthlyClose()`）；
  //   毛利口徑營業額／成本／毛利＝毛利表（`buildGrossMargin()`），有長工糧
  //   run 就用合併成本（更次成本＋介紹費＋長工 Autopay 剔簽證形式）。
  const totals = summaryTotalsFrom(monthlyClose, grossMargin, !!ltRun);
  setCell(ws, row, 1, "總收入／總成本／毛利（同一鍵結算報告同一口徑）");
  ws.getRow(row).font = { bold: true };
  row++;
  setCell(ws, row, 1, "總收入（月結總表，含月結以外）");
  setCell(ws, row, 2, totals.revenue);
  row++;
  // §25.7：資訊行（唔入合計／唔影響上面總收入口徑）——OT 收入已經折入
  // Roster／PostOrder 分頁，呢度俾老闆對返數，答返 revenue 同
  // buildMonthlyClose() P0 口徑（唔含 OT）之間嘅已知差額。
  setCell(ws, row, 1, "OT 收入（已折入 Roster 分頁，唔計入上面總收入——buildMonthlyClose() P0 口徑未含 OT）");
  setCell(ws, row, 2, otRevenueTotal);
  row++;
  setCell(ws, row, 1, "毛利口徑營業額（毛利表）");
  setCell(ws, row, 2, totals.marginRevenue);
  row++;
  const ccs = grossMargin.combinedCostSummary;
  if (totals.costBasis === "combined" && ccs) {
    setCell(ws, row, 1, "更次成本（散工×出街價）");
    setCell(ws, row, 2, ccs.perShiftCostTotal);
    row++;
    setCell(ws, row, 1, "介紹費");
    setCell(ws, row, 2, ccs.referralFeeTotal);
    row++;
    setCell(ws, row, 1, "長工 Autopay（已剔簽證形式）");
    setCell(ws, row, 2, ccs.longtermAutopayTotal);
    row++;
    setCell(ws, row, 1, "合併成本合計");
    setCell(ws, row, 2, totals.cost);
    row++;
    setCell(ws, row, 1, "毛利（毛利口徑營業額－合併成本）");
    setCell(ws, row, 2, totals.grossMargin);
    row++;
    setCell(ws, row, 1, "MPF 僱主供款（另列，唔計入合併成本，同一鍵報告一致）");
    setCell(ws, row, 2, ccs.mpfErTotal);
    row++;
  } else {
    setCell(ws, row, 1, "總成本（毛利表，舊口徑：未含長工 Autopay 實數）");
    setCell(ws, row, 2, totals.cost);
    row++;
    setCell(ws, row, 1, "毛利（毛利表，舊口徑）");
    setCell(ws, row, 2, totals.grossMargin);
    row++;
  }

  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
  return totals;
}

export interface PostorderSummaryTotals {
  revenue: number;
  marginRevenue: number;
  cost: number;
  grossMargin: number;
  costBasis: "combined" | "legacy";
}

/** 同 `stepCompute()`（one-click.ts）一致嘅總收入／成本／毛利。 */
export function summaryTotalsFrom(
  monthlyClose: Awaited<ReturnType<typeof buildMonthlyClose>>,
  grossMargin: Awaited<ReturnType<typeof buildGrossMargin>>,
  hasLongtermRun: boolean,
): PostorderSummaryTotals {
  const revenue = round2([...monthlyClose.mainRows, ...monthlyClose.outsideRows].reduce((a, r) => a + n(r.revenue), 0));
  const marginRevenue = round2(grossMargin.totals.revenue);
  const ccs = grossMargin.combinedCostSummary;
  const useCombined = ccs !== null && hasLongtermRun;
  const cost = useCombined ? ccs.combinedCostTotal : round2(grossMargin.totals.cost);
  const grossMarginValue = useCombined ? round2(marginRevenue - ccs.combinedCostTotal) : round2(grossMargin.totals.profit);
  return { revenue, marginRevenue, cost, grossMargin: grossMarginValue, costBasis: useCombined ? "combined" : "legacy" };
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
    "長工（B07）行：「上單價」同散工行一樣＝收客價；「外判價」＝月薪÷當月更數（真 Postorder 呢格係 #REF!，任務書要求系統出實數）——每位長工月薪（本月生效長工合約；日薪制直接用每更價；冇合約先用安員檔案月薪）按佢喺呢行嘅更數÷佢本月長工總更數拆落呢行，再÷呢行更數。一人一行做足全月＝月薪÷當月更數。呢個係參考單價，唔計入「當月成本」（長工成本以長工糧 Autopay 實數計，見 Summary）。",
    "「月費」行／「收入調整（月結口徑）」行：逐盤收入一律以月結總表（buildMonthlyClose()）為準——月費／admin fee／特別計法嘅盤，逐更收客價加埋同月結口徑唔同，差額寫一行（正數＝月費，負數＝收入調整，例：構造盤／月費盤嘅更同時帶咗逐更收客價），所以 Roster「當月收入」逐盤加總永遠等於月結總表。",
    "Event 分盤（例：啟航1331 Event）：系統係獨立盤（獨立價卡），跟老闆 Postorder 習慣放喺母盤 block——物業名稱寫母盤簡稱、更份前加「Event」、排喺母盤後面；逐行收入唔合併，逐盤加總同月結總表一致。",
    "",
    "Summary「逐雞頭付款」＝ buildPayrollTotals()（src/lib/reports/payroll.ts）——同 gate:reports／gate:pricing 已經對過數嘅同一條 pure function，唔重新發明公式。",
    "Summary「介紹費」＝ computeReferralFeesForMonth()（src/lib/reports/referral-fee.ts）——§19.1 長工介紹雞頭 fallback 邏輯（唔靠 Postorder 上載）。",
    "Summary「長工 Autopay/MPF」＝ 該月最新一個未作廢 longterm_payroll_runs.totals_json。",
    "Summary「總收入/總成本/毛利」＝同一鍵結算報告同一計法：總收入＝月結總表（主表＋月結以外，buildMonthlyClose()）；毛利口徑營業額／成本／毛利＝毛利表 buildGrossMargin()（有長工糧 run 用合併成本：更次成本＋介紹費＋長工 Autopay 剔簽證形式）。",
    "",
    "§14 規則 12（簽證形式長工 salary passthrough）：呢個系統外現金扣減唔喺任何數字反映，總表雞頭數字係扣減前金額——見 Summary 提示行。",
    "§14 規則 12a（卓弘豁免介紹費）：由 2026-09 起生效，8 月結算跟月結表全數支付。",
    "",
    "已知差異項目（§19，8 月驗收時記錄，未必每月都出現，出現時要人手核對）：蔚峰園(W)更表重複行、凱和山 Unbilled 判斷、Weave Hospital Road(T)更表漏記病假。呢啲屬於*上游更表資料*本身嘅已知落差，唔係呢個 export 模組嘅 bug——見 scripts/gate/postorder-export-aug.ts 差異表。",
    "OT（record_type=ot）：WP-BOSS5 §25.7（老闆 2026-09-28 追加決定 #7）起折入 Roster／PostOrder——同一 (盤, OT 更種, 結算雞頭) 一組，行標籤用 OT 更種 label（例「1Hr OT」）；「更數」＝Σ ot_hours（以小時做更數，配合 §25.1 OT 卡＝每小時价）；上單價／外判價＝snapshot÷ot_hours（即每小時价）。呢部分收入已經計入 Roster「當月收入」／Summary「逐雞頭付款」／`siteRevenue.revenue`，但 `buildMonthlyClose()`（月結總表 P0 口徑）本身唔含 OT——Summary「總收入」呢個特定總數維持一鍵報告口徑（唔含 OT），另有一行「OT 收入（已折入 Roster 分頁）」俾老闆對數。",
  ];
  lines.forEach((l, i) => setCell(ws, i + 1, 1, l));
  ws.getColumn(1).width = 100;
}

export async function buildPostorderWorkbook(month: Date): Promise<PostorderWorkbookResult> {
  const wb = new ExcelJS.Workbook();
  const { groups, daysInMonth } = await loadRosterGroups(month);

  const [payrollTotals, referral, monthClose, brokers, sites, monthlyClose, grossMargin] = await Promise.all([
    buildPayrollTotals(month),
    computeReferralFeesForMonth(month),
    prisma.monthClose.findUnique({ where: { month: reportMonthRange(month).start }, select: { lockedAt: true } }),
    prisma.broker.findMany({ select: { id: true, name: true } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true, clientName: true, aliases: true } }),
    buildMonthlyClose(month),
    buildGrossMargin(month),
  ]);
  const brokerNameById = new Map(brokers.map((b) => [b.id, b.name]));
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const siteClientNameById = new Map(sites.map((s) => [s.id, s.clientName]));
  const siteDisplayById = new Map(sites.map((s) => [s.id, shortestAlias(s.canonicalName, s.aliases)]));

  const longtermGuardIds = new Set<string>();
  const totalB07ShiftsByGuard = new Map<string, number>();
  for (const g of groups) {
    for (const id of g.longtermGuardIds) longtermGuardIds.add(id);
    for (const [id, c] of g.longtermShiftsByGuard) totalB07ShiftsByGuard.set(id, (totalB07ShiftsByGuard.get(id) ?? 0) + c);
  }
  const { start: mStart, end: mEnd } = reportMonthRange(month);
  const [longtermGuards, contracts] =
    longtermGuardIds.size > 0
      ? await Promise.all([
          prisma.guard.findMany({ where: { id: { in: [...longtermGuardIds] } }, select: { id: true, monthlySalary: true } }),
          prisma.guardLongtermContract.findMany({
            where: { guardId: { in: [...longtermGuardIds] }, effectiveFrom: { lte: mEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: mStart } }] },
            orderBy: { effectiveFrom: "asc" },
            select: { guardId: true, monthlySalary: true, payBasis: true, dailyRate: true },
          }),
        ])
      : [[], []];
  const payBasisByGuard = new Map<string, LongtermPayBasisInfo>();
  for (const g of longtermGuards) if (g.monthlySalary !== null && n(g.monthlySalary) > 0) payBasisByGuard.set(g.id, { kind: "monthly", monthlySalary: n(g.monthlySalary) });
  // 合約優先；同月多段（月中轉約）取最後生效嗰段做參考單價。
  for (const c of contracts) {
    if (c.payBasis === "daily" && c.dailyRate !== null) payBasisByGuard.set(c.guardId, { kind: "daily", dailyRate: n(c.dailyRate) });
    else payBasisByGuard.set(c.guardId, { kind: "monthly", monthlySalary: n(c.monthlySalary) });
  }
  const longtermPayoutRate = (g: RosterGroup) => longtermRowPayoutRate(g.longtermShiftsByGuard, totalB07ShiftsByGuard, payBasisByGuard);

  // 逐盤「更次收入」（groups 加總，`shift_records.client_rate_snapshot`
  // 之和）vs `buildMonthlyClose()` 嘅權威逐盤收入（已經包埋 flat 月費卡／
  // pro-rata fallback，見 monthly-close.ts `flatCard`/`monthlyFeeProrataRevenue`
  // ——呢層邏輯好複雜、已經驗證過，呢度唔重新發明，直接借用差額）。差額
  // 大過 0 嘅盤（月費／admin_fee／special billing，`client_rate_snapshot`
  // 本身唔記逐更收客，收入淨係喺 flat 卡度）加一行合成「月費」row，等
  // Roster/PostOrder/Summary 逐盤收入唔會漏咗呢批盤（8 月實測：IFC／
  // 控制室／九龍企業大廈／創富廠IC／屯門小欖樂怡街5號／都會大學夜巡邏／
  // M+／恆星樓 呢類盤冇呢個補丁會顯示 0 收入）。
  //
  // WP-BOSS5 §25.7：`buildMonthlyClose()`（P0 口徑）刻意唔含 OT（`record_
  // type=ot`），但呢個 export 嘅 `groups` 而家有 OT 行（`g.isOt`）。呢度
  // 淨係用非 OT 組嚟同 `buildMonthlyClose()` 對——OT 組嘅收入唔可以落嚟
  // 呢條「補差」公式，否則會將 OT 收入當「口徑差額」沖銷走（見下面 flat
  // adjustment），令 Roster/siteRevenue 嘅 OT 收入憑空消失。
  const perShiftRevenueBySite = new Map<string, number>();
  for (const g of groups) {
    if (g.isOt) continue;
    perShiftRevenueBySite.set(g.key.siteId, round2((perShiftRevenueBySite.get(g.key.siteId) ?? 0) + g.revenue));
  }
  const flatRevenueRows: FlatRevenueRow[] = [];
  // Opus 5.5 驗收：差額係負數（月結口徑收入少過逐更收客 Σ）或者盤喺
  // 月結總表完全冇出現，原版會靜靜略過，令 Roster 逐盤收入同月結總表對唔
  // 上——而家一律加一行「收入調整（月結口徑）」補齊，逐盤（剔走 OT）加總
  // 永遠等於 `buildMonthlyClose()`（金額照寫，唔會收埋）；OT 收入另外喺
  // `PostorderSiteRevenue.otRevenue`／Roster OT 行反映，唔喺呢條調整入面。
  const closeRevenueBySite = new Map<string, { revenue: number; canonicalName: string }>();
  for (const r of [...monthlyClose.mainRows, ...monthlyClose.outsideRows]) closeRevenueBySite.set(r.siteId, { revenue: n(r.revenue), canonicalName: r.canonicalName });
  const siteIdsInOrder = [...closeRevenueBySite.keys(), ...[...perShiftRevenueBySite.keys()].filter((id) => !closeRevenueBySite.has(id))];
  for (const siteId of siteIdsInOrder) {
    const close = closeRevenueBySite.get(siteId);
    const perShift = perShiftRevenueBySite.get(siteId) ?? 0;
    const flatPortion = round2((close?.revenue ?? 0) - perShift);
    if (Math.abs(flatPortion) > 0.005) {
      flatRevenueRows.push({
        siteId,
        siteName: siteDisplayById.get(siteId) ?? close?.canonicalName ?? siteId,
        clientName: siteClientNameById.get(siteId) ?? null,
        amount: flatPortion,
        label: flatPortion > 0 ? "月費" : "收入調整（月結口徑）",
      });
    }
  }

  // §25.7：OT 收入合計（Summary 資訊行＋俾 gate/caller 拆走 OT 用）。
  const otRevenueTotal = round2(groups.filter((g) => g.isOt).reduce((a, g) => a + g.revenue, 0));

  await writeRosterSheet(wb, groups, daysInMonth, !!monthClose?.lockedAt, longtermPayoutRate, flatRevenueRows);
  await writePostOrderSheet(wb, groups, daysInMonth, referral, brokerNameById, siteNameById, flatRevenueRows);
  const summaryTotals = await writeSummarySheet(wb, month, payrollTotals, referral, monthlyClose, grossMargin, otRevenueTotal);
  await writeLegendSheet(wb, month);

  const siteRevenueTotal = round2(groups.reduce((a, g) => a + g.revenue, 0) + flatRevenueRows.reduce((a, r) => a + r.amount, 0));
  const siteCostTotal = round2(groups.reduce((a, g) => a + g.cost, 0));

  const siteRevenueBySite = new Map<string, PostorderSiteRevenue>();
  for (const g of groups) {
    const cur = siteRevenueBySite.get(g.key.siteId);
    if (cur) {
      cur.shifts += g.shiftCount;
      cur.revenue = round2(cur.revenue + g.revenue);
      cur.cost = round2(cur.cost + g.cost);
      if (g.isOt) {
        cur.otRevenue = round2(cur.otRevenue + g.revenue);
        cur.otShifts = round2(cur.otShifts + g.shiftCount);
      }
    } else {
      siteRevenueBySite.set(g.key.siteId, {
        siteId: g.key.siteId,
        siteName: siteNameById.get(g.key.siteId) ?? g.siteName,
        shifts: g.shiftCount,
        revenue: g.revenue,
        cost: g.cost,
        otRevenue: g.isOt ? g.revenue : 0,
        otShifts: g.isOt ? g.shiftCount : 0,
      });
    }
  }
  for (const r of flatRevenueRows) {
    const cur = siteRevenueBySite.get(r.siteId);
    if (cur) cur.revenue = round2(cur.revenue + r.amount);
    else siteRevenueBySite.set(r.siteId, { siteId: r.siteId, siteName: siteNameById.get(r.siteId) ?? r.siteName, shifts: 0, revenue: r.amount, cost: 0, otRevenue: 0, otShifts: 0 });
  }

  return {
    workbook: wb,
    month: monthLabel(month),
    daysInMonth,
    rosterRowCount: groups.length + flatRevenueRows.length,
    brokerPayouts: payrollTotals.map((t) => ({ brokerId: t.brokerId, brokerCode: t.brokerCode, brokerName: t.brokerName, amount: t.amount, shifts: t.shifts })),
    referralFeeTotal: referral.totalAmount,
    siteRevenueTotal,
    siteCostTotal,
    siteRevenue: [...siteRevenueBySite.values()],
    summaryTotals,
  };
}
