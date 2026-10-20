// WP-AI-OPS §28.3（第 1 期）：鎖月前體檢＋資料補齊提示。
//
// `buildMonthHealth(month)`——純讀、批量查詢（固定條數，唔隨盤數／人數增加），
// 唔改任何現有報表數字、**唔擋鎖月**（只提示）。每個 finding：
// {code, severity, count, message, fixLink, requires, detail}。
//
// 明細（detail）可以有姓名／工號——所以呢個 lib 回完整明細，由 route 經
// `redactMonthHealth()` 按讀者權限剝走（要「更表」view；缺身份證要「保安員個人資料」
// view；缺銀行編號要「保安員銀行資料」view；冇權限只回數量）。hkid／電話號碼本身
// 一律唔會出現喺任何明細入面——缺資料類只講「缺邊樣」，唔回值。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertNotHistoricalMonth } from "@/lib/month-close/historical";
import { n, round2, monthRange, monthStart as toMonthStart } from "@/lib/reports/money";
import { buildMonthlyClose, type MonthlyCloseSiteRow } from "@/lib/reports/monthly-close";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { addMonths } from "./digest";
import {
  BROKER_PAYABLE_SWING_PCT,
  MARGIN_SWING_POINTS,
  MAX_DETAIL_ROWS,
  MAX_SHIFTS_PER_GUARD_MONTH,
  MIN_BASE_AMOUNT,
  MIN_BASE_SHIFTS,
  REFERRAL_SWING_PCT,
  SWING_PCT,
} from "./thresholds";

export type HealthSeverity = "info" | "warn" | "critical";

interface HealthFinding {
  code: string;
  severity: HealthSeverity;
  count: number;
  /** 說明（已填好數字）。 */
  message: string;
  /** 修正頁連結（內部路徑）。 */
  fixLink: string;
  /** 睇明細所需 module（全部要有 view）。 */
  requires: string[];
  detail: Array<Record<string, unknown>> | null;
  detailTruncated: boolean;
  /** route 剝走明細之後設 true（讀者冇權限，只有數量）。 */
  detailWithheld?: boolean;
}

export interface MonthHealth {
  month: string;
  prevMonth: string;
  hasPrev: boolean;
  summary: { critical: number; warn: number; info: number; total: number };
  findings: HealthFinding[];
}

const ROSTER_VIEW = "更表";
const PII_VIEW = "安員個人資料";
const BANK_VIEW = "安員銀行資料";

function pct(cur: number, prev: number): number {
  return prev === 0 ? 0 : round2(((cur - prev) / Math.abs(prev)) * 100);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function minutesOf(t: Date | null): number | null {
  return t ? t.getUTCHours() * 60 + t.getUTCMinutes() : null;
}

/** 純函數：兩段時間（分鐘，可跨午夜）有冇重疊（有單元測試）。 */
export function intervalsOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const ae = a.end <= a.start ? a.end + 1440 : a.end;
  const be = b.end <= b.start ? b.end + 1440 : b.end;
  return a.start < be && b.start < ae;
}

/** 純函數：swing 判斷（有單元測試）——基數太細唔比較。 */
export function isSwing(cur: number, prev: number, minBase: number, thresholdPct: number): boolean {
  if (Math.abs(prev) < minBase) return false;
  return Math.abs(pct(cur, prev)) > thresholdPct;
}

type Detail = Array<Record<string, unknown>>;

function finding(f: Omit<HealthFinding, "detail" | "detailTruncated"> & { detail?: Detail }): HealthFinding | null {
  if (f.count <= 0) return null;
  const detail = f.detail ?? null;
  return { ...f, detail: detail ? detail.slice(0, MAX_DETAIL_ROWS) : null, detailTruncated: !!detail && detail.length > MAX_DETAIL_ROWS };
}

export async function buildMonthHealth(month: Date, session: AuthedSession): Promise<MonthHealth> {
  await assertNotHistoricalMonth(month, "月結健康體檢"); // HIST-1
  const m0 = toMonthStart(month);
  const m1 = addMonths(m0, -1);
  const { start, end } = monthRange(m0);
  const label = m0.toISOString().slice(0, 7);
  const monthQ = `month=${label}`;

  const [records, uploads, unpriced, closeCur, closePrev, payCur, payPrev, referral, sites, ltLines] = await Promise.all([
    prisma.shiftRecord.findMany({
      where: { workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
      select: { id: true, workDate: true, siteId: true, shiftTypeId: true, guardId: true, recordType: true },
    }),
    prisma.rosterUpload.findMany({ where: { month: m0, status: { in: ["parsed", "confirmed"] }, voidedAt: null }, select: { id: true, siteNameRaw: true, site: { select: { canonicalName: true } } } }),
    buildUnpricedSummary(session, m0),
    buildMonthlyClose(m0),
    buildMonthlyClose(m1),
    buildPayrollTotals(m0),
    buildPayrollTotals(m1),
    prisma.specialItem.groupBy({ by: ["month"], where: { month: { in: [m0, m1] }, kind: "referral_fee", voidedAt: null }, _sum: { cost: true } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true, billingModel: true, status: true, activityProxySiteId: true, staffScheme: true } }),
    prisma.longtermPayrollLine.findMany({ where: { run: { month: m0, voidedAt: null } }, select: { guardId: true } }),
  ]);
  const uploadIds = uploads.map((u) => u.id);
  const uploadName = new Map(uploads.map((u) => [u.id, u.site?.canonicalName ?? u.siteNameRaw]));
  const siteName = new Map(sites.map((s) => [s.id, s.canonicalName]));

  const guardIds = [...new Set([...records.map((r) => r.guardId), ...ltLines.map((l) => l.guardId)])];
  const shiftTypeIds = [...new Set(records.map((r) => r.shiftTypeId))];
  const [guards, shiftTypes, matchGroups, dupGroups] = await Promise.all([
    prisma.guard.findMany({
      where: { id: { in: guardIds } },
      select: { id: true, nameZh: true, staffNo: true, employmentType: true, siaPermitExpiry: true, hkid: true, tel: true, bankCode: true },
    }),
    prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } }, select: { id: true, startTime: true, endTime: true } }),
    uploadIds.length
      ? prisma.rosterUploadRow.groupBy({
          by: ["uploadId", "guardMatch", "matchBasis"],
          where: { uploadId: { in: uploadIds }, codeKind: { in: ["shift", "ot", "leave"] } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ uploadId: string; guardMatch: string; matchBasis: string | null; _count: { _all: number } }>),
    uploadIds.length
      ? prisma.rosterUploadRow.groupBy({
          by: ["uploadId", "guardId", "workDate", "rawCode"],
          where: { uploadId: { in: uploadIds }, guardId: { not: null }, codeKind: { in: ["shift", "ot"] } },
          having: { id: { _count: { gt: 1 } } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ uploadId: string; guardId: string | null; workDate: Date; rawCode: string; _count: { _all: number } }>),
  ]);
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const stById = new Map(shiftTypes.map((s) => [s.id, { start: minutesOf(s.startTime), end: minutesOf(s.endTime) }]));
  const who = (id: string) => {
    const g = guardById.get(id);
    return { name_zh: g?.nameZh ?? null, staff_no: g?.staffNo ?? null };
  };

  const out: HealthFinding[] = [];
  const push = (f: HealthFinding | null) => {
    if (f) out.push(f);
  };

  // --- 1. 同人同日多更：時間重疊／跨盤 ------------------------------------
  const shifts = records.filter((r) => r.recordType === "shift");
  const byGuardDay = new Map<string, typeof shifts>();
  for (const r of shifts) {
    const k = `${r.guardId}|${iso(r.workDate)}`;
    const arr = byGuardDay.get(k);
    if (arr) arr.push(r);
    else byGuardDay.set(k, [r]);
  }
  const overlapDetail: Detail = [];
  const crossDetail: Detail = [];
  for (const [k, arr] of byGuardDay) {
    if (arr.length < 2) continue;
    const [gid, day] = k.split("|") as [string, string];
    let overlap = false;
    for (let i = 0; i < arr.length && !overlap; i++) {
      for (let j = i + 1; j < arr.length && !overlap; j++) {
        const a = stById.get(arr[i]!.shiftTypeId);
        const b = stById.get(arr[j]!.shiftTypeId);
        if (a && b && a.start !== null && a.end !== null && b.start !== null && b.end !== null) {
          overlap = intervalsOverlap({ start: a.start, end: a.end }, { start: b.start, end: b.end });
        }
      }
    }
    const siteIds = [...new Set(arr.map((r) => r.siteId))];
    if (overlap) overlapDetail.push({ ...who(gid), work_date: day, sites: siteIds.map((s) => siteName.get(s) ?? ""), shifts: arr.length });
    else if (siteIds.length > 1) crossDetail.push({ ...who(gid), work_date: day, sites: siteIds.map((s) => siteName.get(s) ?? ""), shifts: arr.length });
  }
  push(finding({ code: "overlap_same_day", severity: "critical", count: overlapDetail.length, message: `${overlapDetail.length} 個「人＋日」有時間重疊嘅多更（同一人同日兩更時間疊埋）`, fixLink: `/roster?${monthQ}`, requires: [ROSTER_VIEW], detail: overlapDetail }));
  push(finding({ code: "cross_site_same_day", severity: "warn", count: crossDetail.length, message: `${crossDetail.length} 個「人＋日」同日喺不同盤出更（時間冇重疊，請確認）`, fixLink: `/roster?${monthQ}`, requires: [ROSTER_VIEW], detail: crossDetail }));

  // --- 1b. EMP-P2：未標工號更次／盤未設 staff_scheme（直達卡：帶去設定位）-------------------
  // 「未標工號」＝shift_records.staff_number_id 冇值、而且鎖月側表都冇歸屬（P1 回填）。逐人糧單會將呢啲更歸「未標工號」一行，唔會靜靜併入 U。
  const unmarked = await prisma.$queryRaw<Array<{ site_id: string; shifts: bigint }>>(Prisma.sql`
    SELECT sr.site_id AS site_id, COUNT(*) AS shifts
      FROM shift_records sr
      LEFT JOIN shift_record_staff_attributions a ON a.shift_record_id = sr.id
     WHERE sr.record_type IN ('shift', 'ot') AND sr.status <> 'cancelled'
       AND sr.work_date >= ${iso(start)}::date AND sr.work_date <= ${iso(end)}::date
       AND sr.staff_number_id IS NULL AND a.shift_record_id IS NULL
     GROUP BY 1 ORDER BY 2 DESC`);
  const unmarkedTotal = unmarked.reduce((a, r) => a + Number(r.shifts), 0);
  push(
    finding({
      code: "shifts_no_staff_number",
      severity: "warn",
      count: unmarkedTotal,
      message: `${unmarkedTotal} 更未標工號（逐人糧單會歸入「未標工號」一行）——去設定盤嘅工號體系、補齊人嘅工號卡，再用回填標返`,
      fixLink: "/sites",
      requires: [ROSTER_VIEW],
      detail: unmarked.map((r) => ({ site_name: siteName.get(r.site_id) ?? "", shifts: Number(r.shifts) })),
    }),
  );
  const shiftsBySiteAll = new Map<string, number>();
  for (const r of records) if (r.recordType === "shift" || r.recordType === "ot") shiftsBySiteAll.set(r.siteId, (shiftsBySiteAll.get(r.siteId) ?? 0) + 1);
  const noScheme = sites.filter((s) => s.staffScheme === null && (shiftsBySiteAll.get(s.id) ?? 0) > 0);
  push(
    finding({
      code: "site_no_staff_scheme",
      severity: "info",
      count: noScheme.length,
      message: `${noScheme.length} 個本月有出更嘅盤未設工號體系（staff_scheme）——更表／匯出照舊印 U，更次亦推唔到工號卡`,
      fixLink: "/sites/staff-scheme-prefill",
      requires: [ROSTER_VIEW],
      detail: noScheme.map((s) => ({ site_name: s.canonicalName, shifts: shiftsBySiteAll.get(s.id) ?? 0 })).sort((a, b) => b.shifts - a.shifts),
    }),
  );

  // --- 2. 單月 > 26 更 -----------------------------------------------------
  const shiftCountByGuard = new Map<string, number>();
  for (const r of shifts) shiftCountByGuard.set(r.guardId, (shiftCountByGuard.get(r.guardId) ?? 0) + 1);
  const heavy = [...shiftCountByGuard.entries()].filter(([, c]) => c > MAX_SHIFTS_PER_GUARD_MONTH).sort((a, b) => b[1] - a[1]);
  push(finding({ code: "over_max_shifts", severity: "warn", count: heavy.length, message: `${heavy.length} 人單月出更超過 ${MAX_SHIFTS_PER_GUARD_MONTH} 更`, fixLink: `/roster?${monthQ}`, requires: [ROSTER_VIEW], detail: heavy.map(([gid, c]) => ({ ...who(gid), shift_count: c })) }));

  // --- 3. 更表重複行 ---------------------------------------------------------
  push(
    finding({
      code: "roster_duplicate_rows",
      severity: "warn",
      count: dupGroups.length,
      message: `${dupGroups.length} 組更表重複行（同一份更表內同人同日同更種出現多次）`,
      fixLink: "/roster-uploads",
      requires: [ROSTER_VIEW],
      detail: dupGroups.map((d) => ({ ...(d.guardId ? who(d.guardId) : {}), site_name: uploadName.get(d.uploadId) ?? "", work_date: iso(d.workDate), raw_code: d.rawCode, rows: d._count._all })),
    }),
  );

  // --- 4. 長工同日有假又有更 -----------------------------------------------------
  const leaveByGuardDay = new Set(records.filter((r) => r.recordType === "leave").map((r) => `${r.guardId}|${iso(r.workDate)}`));
  const llDetail: Detail = [];
  for (const [k] of byGuardDay) {
    if (!leaveByGuardDay.has(k)) continue;
    const [gid, day] = k.split("|") as [string, string];
    if (guardById.get(gid)?.employmentType === "longterm_autopay") llDetail.push({ ...who(gid), work_date: day });
  }
  // byGuardDay 只收 ≥1 條 shift（上面只有 push 冇過濾 length），所以呢度即「同日有更又有假」
  push(finding({ code: "longterm_leave_and_shift", severity: "warn", count: llDetail.length, message: `${llDetail.length} 個長工「人＋日」同日既有假又有更`, fixLink: `/roster?${monthQ}`, requires: [ROSTER_VIEW], detail: llDetail }));

  // --- 5. 未定價 ---------------------------------------------------------------
  const groupsBy = (cat: string): Detail =>
    unpriced.groups.filter((g) => g.category === cat).map((g) => ({ site_name: g.site_name, broker_code: g.broker_code, shift_type_code: g.shift_type_code, count: g.count }));
  const catCount = (cat: string) => unpriced.groups.filter((g) => g.category === cat).reduce((a, g) => a + g.count, 0);
  push(finding({ code: "unpriced_payout", severity: "critical", count: catCount("payout_unpriced"), message: `${catCount("payout_unpriced")} 更出街價未定（成本未計入）`, fixLink: "/rate-cards", requires: [ROSTER_VIEW], detail: groupsBy("payout_unpriced") }));
  push(finding({ code: "unpriced_client", severity: "critical", count: catCount("client_unpriced"), message: `${catCount("client_unpriced")} 更收客價未定（收入未計入）`, fixLink: "/rate-cards", requires: [ROSTER_VIEW], detail: groupsBy("client_unpriced") }));
  push(finding({ code: "no_settlement", severity: "critical", count: catCount("no_settlement"), message: `${catCount("no_settlement")} 更冇結算單位（糧明細會消失）`, fixLink: `/roster-uploads`, requires: [ROSTER_VIEW], detail: groupsBy("no_settlement") }));
  push(finding({ code: "ot_unpriced", severity: "warn", count: catCount("ot_unpriced"), message: `${catCount("ot_unpriced")} 條 OT 記錄未定價`, fixLink: "/rate-cards", requires: [ROSTER_VIEW], detail: groupsBy("ot_unpriced") }));

  // --- 6. name_only／ambiguous／unmatched 格 ---------------------------------------
  const cellsBy = (pred: (g: { guardMatch: string; matchBasis: string | null }) => boolean): Detail => {
    const perUpload = new Map<string, number>();
    for (const g of matchGroups) if (pred(g)) perUpload.set(g.uploadId, (perUpload.get(g.uploadId) ?? 0) + g._count._all);
    return [...perUpload.entries()].map(([u, c]) => ({ site_name: uploadName.get(u) ?? "", cells: c })).sort((a, b) => (b.cells as number) - (a.cells as number));
  };
  const sumCells = (d: Detail) => d.reduce((a, r) => a + (r.cells as number), 0);
  const nameOnly = cellsBy((g) => g.matchBasis === "name_only" && g.guardMatch !== "unmatched" && g.guardMatch !== "ambiguous");
  const ambiguous = cellsBy((g) => g.guardMatch === "ambiguous");
  const unmatched = cellsBy((g) => g.guardMatch === "unmatched");
  push(finding({ code: "ambiguous_cells", severity: "critical", count: sumCells(ambiguous), message: `${sumCells(ambiguous)} 格保安員配對有多個候選（ambiguous）`, fixLink: "/roster-uploads", requires: [ROSTER_VIEW], detail: ambiguous }));
  push(finding({ code: "unmatched_cells", severity: "critical", count: sumCells(unmatched), message: `${sumCells(unmatched)} 格保安員配對唔到（unmatched）`, fixLink: "/guard-fix", requires: [ROSTER_VIEW], detail: unmatched }));
  push(finding({ code: "name_only_cells", severity: "warn", count: sumCells(nameOnly), message: `${sumCells(nameOnly)} 格淨靠姓名配對（建議補工號或電話）`, fixLink: "/roster-uploads", requires: [ROSTER_VIEW], detail: nameOnly }));

  // --- 7. 許可證過期仍出更 ---------------------------------------------------------------
  const expiredBy = new Map<string, number>();
  for (const r of shifts) {
    const g = guardById.get(r.guardId);
    if (!g || g.employmentType === "external" || !g.siaPermitExpiry) continue;
    if (r.workDate.getTime() > g.siaPermitExpiry.getTime()) expiredBy.set(g.id, (expiredBy.get(g.id) ?? 0) + 1);
  }
  push(
    finding({
      code: "permit_expired_working",
      severity: "warn",
      count: expiredBy.size,
      message: `${expiredBy.size} 人喺許可證到期後仍有出更`,
      fixLink: "/guards",
      requires: [ROSTER_VIEW],
      detail: [...expiredBy.entries()].sort((a, b) => b[1] - a[1]).map(([gid, c]) => ({ ...who(gid), permit_expiry: iso(guardById.get(gid)!.siaPermitExpiry as Date), shifts_after_expiry: c })),
    }),
  );

  // --- 8. 逐盤同上月比較 ---------------------------------------------------------------------
  const rowsOf = (c: Awaited<ReturnType<typeof buildMonthlyClose>>): MonthlyCloseSiteRow[] => [...c.mainRows, ...c.outsideRows];
  const prevRows = new Map(rowsOf(closePrev).map((r) => [r.siteId, r]));
  const curRows = rowsOf(closeCur);
  const hasPrev = rowsOf(closePrev).some((r) => r.shifts > 0 || n(r.revenue) > 0);
  const shiftSwing: Detail = [];
  const revSwing: Detail = [];
  const costSwing: Detail = [];
  const marginSwing: Detail = [];
  const revNoCost: Detail = [];
  for (const r of curRows) {
    const revenue = n(r.revenue);
    const cost = n(r.cost);
    if (revenue > 0 && cost === 0) revNoCost.push({ site_name: r.canonicalName, revenue: round2(revenue), cost: 0, shifts: r.shifts });
    if (!hasPrev) continue;
    const p = prevRows.get(r.siteId);
    if (!p) continue;
    if (isSwing(r.shifts, p.shifts, MIN_BASE_SHIFTS, SWING_PCT)) shiftSwing.push({ site_name: r.canonicalName, prev: p.shifts, cur: r.shifts, change_pct: pct(r.shifts, p.shifts) });
    if (isSwing(revenue, n(p.revenue), MIN_BASE_AMOUNT, SWING_PCT)) revSwing.push({ site_name: r.canonicalName, prev: round2(n(p.revenue)), cur: round2(revenue), change_pct: pct(revenue, n(p.revenue)) });
    if (isSwing(cost, n(p.cost), MIN_BASE_AMOUNT, SWING_PCT)) costSwing.push({ site_name: r.canonicalName, prev: round2(n(p.cost)), cur: round2(cost), change_pct: pct(cost, n(p.cost)) });
    if (r.marginPct !== null && p.marginPct !== null && Math.abs(n(p.revenue)) >= MIN_BASE_AMOUNT && Math.abs(r.marginPct - p.marginPct) > MARGIN_SWING_POINTS) {
      marginSwing.push({ site_name: r.canonicalName, prev_margin_pct: p.marginPct, cur_margin_pct: r.marginPct, change_points: round2(r.marginPct - p.marginPct) });
    }
  }
  push(finding({ code: "revenue_without_cost", severity: "critical", count: revNoCost.length, message: `${revNoCost.length} 個盤有收入但成本係 0`, fixLink: `/reports/monthly-close?${monthQ}`, requires: [ROSTER_VIEW], detail: revNoCost }));
  push(finding({ code: "site_shifts_swing", severity: "warn", count: shiftSwing.length, message: `${shiftSwing.length} 個盤更數同上月相差超過 ${SWING_PCT}%`, fixLink: `/reports/monthly-close?${monthQ}`, requires: [ROSTER_VIEW], detail: shiftSwing }));
  push(finding({ code: "site_revenue_swing", severity: "warn", count: revSwing.length, message: `${revSwing.length} 個盤收入同上月相差超過 ${SWING_PCT}%`, fixLink: `/reports/monthly-close?${monthQ}`, requires: [ROSTER_VIEW], detail: revSwing }));
  push(finding({ code: "site_cost_swing", severity: "warn", count: costSwing.length, message: `${costSwing.length} 個盤成本同上月相差超過 ${SWING_PCT}%`, fixLink: `/reports/monthly-close?${monthQ}`, requires: [ROSTER_VIEW], detail: costSwing }));
  push(finding({ code: "site_margin_swing", severity: "warn", count: marginSwing.length, message: `${marginSwing.length} 個盤毛利率同上月相差超過 ${MARGIN_SWING_POINTS} 個百分點`, fixLink: `/reports/monthly-close?${monthQ}`, requires: [ROSTER_VIEW], detail: marginSwing }));

  // 月費盤冇活動（自己同 proxy 盤都 0 更）
  const shiftsBySite = new Map(curRows.map((r) => [r.siteId, r.shifts]));
  const noActivity: Detail = [];
  for (const s of sites) {
    if (s.billingModel !== "monthly_fixed" || s.status !== "active") continue;
    if (!shiftsBySite.has(s.id)) continue; // 月結總表冇列（不在範圍）
    const own = shiftsBySite.get(s.id) ?? 0;
    const proxy = s.activityProxySiteId ? (shiftsBySite.get(s.activityProxySiteId) ?? 0) : 0;
    if (own === 0 && proxy === 0) noActivity.push({ site_name: s.canonicalName });
  }
  push(finding({ code: "monthly_fee_no_activity", severity: "warn", count: noActivity.length, message: `${noActivity.length} 個月費盤本月完全冇出更記錄（月費照收，請確認）`, fixLink: `/roster?${monthQ}`, requires: [ROSTER_VIEW], detail: noActivity }));

  // --- 9. 逐雞頭應付／介紹費同上月比較 ----------------------------------------------------------
  if (hasPrev) {
    const prevPay = new Map(payPrev.map((p) => [p.brokerCode, p]));
    const paySwing: Detail = [];
    for (const p of payCur) {
      const q = prevPay.get(p.brokerCode);
      if (q && isSwing(p.amount, q.amount, MIN_BASE_AMOUNT, BROKER_PAYABLE_SWING_PCT)) paySwing.push({ broker_code: p.brokerCode, prev: round2(q.amount), cur: round2(p.amount), change_pct: pct(p.amount, q.amount) });
    }
    push(finding({ code: "broker_payable_swing", severity: "warn", count: paySwing.length, message: `${paySwing.length} 個雞頭應付同上月相差超過 ${BROKER_PAYABLE_SWING_PCT}%`, fixLink: "/reports/payroll", requires: [ROSTER_VIEW], detail: paySwing }));
    const refCur = n(referral.find((r) => r.month.getTime() === m0.getTime())?._sum.cost);
    const refPrev = n(referral.find((r) => r.month.getTime() === m1.getTime())?._sum.cost);
    if (isSwing(refCur, refPrev, MIN_BASE_AMOUNT, REFERRAL_SWING_PCT)) {
      push(finding({ code: "referral_total_swing", severity: "warn", count: 1, message: `介紹費總額同上月相差超過 ${REFERRAL_SWING_PCT}%（上月 ${round2(refPrev)}，本月 ${round2(refCur)}）`, fixLink: "/reports/monthly-close", requires: [ROSTER_VIEW], detail: [{ prev: round2(refPrev), cur: round2(refCur), change_pct: pct(refCur, refPrev) }] }));
    }
  }

  // --- 10. 資料補齊：缺身份證／電話／（長工）銀行編號 ------------------------------------------------
  const ltGuardIds = new Set(ltLines.map((l) => l.guardId));
  const active = guards.filter((g) => g.employmentType !== "external" && (shiftCountByGuard.has(g.id) || ltGuardIds.has(g.id)));
  const gapRows = (pred: (g: (typeof guards)[number]) => boolean): Detail =>
    active
      .filter(pred)
      .sort((a, b) => (shiftCountByGuard.get(b.id) ?? 0) - (shiftCountByGuard.get(a.id) ?? 0))
      .map((g) => ({ name_zh: g.nameZh, staff_no: g.staffNo, shift_count: shiftCountByGuard.get(g.id) ?? 0 }));
  const noHkid = gapRows((g) => !g.hkid);
  const noTel = gapRows((g) => !g.tel);
  const noBank = gapRows((g) => g.employmentType === "longterm_autopay" && !g.bankCode);
  push(finding({ code: "gap_hkid", severity: "info", count: noHkid.length, message: `${noHkid.length} 位本月有出更／有糧嘅保安員缺身份證號碼`, fixLink: "/guards", requires: [ROSTER_VIEW, PII_VIEW], detail: noHkid }));
  push(finding({ code: "gap_tel", severity: "info", count: noTel.length, message: `${noTel.length} 位本月有出更／有糧嘅保安員缺電話`, fixLink: "/guards", requires: [ROSTER_VIEW], detail: noTel }));
  push(finding({ code: "gap_bank_code", severity: "warn", count: noBank.length, message: `${noBank.length} 位長工缺銀行編號（出 autopay 檔會缺）`, fixLink: "/reports/longterm-payroll", requires: [ROSTER_VIEW, BANK_VIEW], detail: noBank }));

  // P14.3：本月銀行對數（資訊，唔擋鎖月）——有長工糧 run 先出：未上載 → 提示上載；已上載 → 未解釋差異數。
  {
    const [rec, activeRun] = await Promise.all([
      prisma.longtermBankReconciliation.findFirst({ where: { month: m0 }, orderBy: { uploadedAt: "desc" }, select: { id: true, runId: true } }),
      prisma.longtermPayrollRun.findFirst({ where: { month: m0, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" }, select: { id: true } }),
    ]);
    if (!rec && ltLines.length === 0) {
      // 本月冇長工糧 run，無需對數
    } else if (rec && activeRun && rec.runId !== activeRun.id) {
      push(finding({ code: "bank_reconcile", severity: "info", count: 1, message: "本月銀行對數已過時（上載後本月糧已重算），請重新上載銀行檔", fixLink: `/reports/longterm-payroll?${monthQ}`, requires: [] }));
    } else if (!rec) {
      push(finding({ code: "bank_reconcile", severity: "info", count: 1, message: "本月銀行對數：未上載（長工糧頁 › 銀行對數）", fixLink: `/reports/longterm-payroll?${monthQ}`, requires: [] }));
    } else {
      const unresolved = await prisma.longtermBankReconciliationRow.count({ where: { reconciliationId: rec.id, status: { not: "equal" }, reasonCode: null } });
      push(finding({ code: "bank_reconcile", severity: "info", count: unresolved, message: `本月銀行對數：${unresolved} 項未解釋`, fixLink: `/reports/longterm-payroll?${monthQ}`, requires: [] }));
    }
  }

  const rank: Record<HealthSeverity, number> = { critical: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
  const summary = {
    critical: out.filter((f) => f.severity === "critical").length,
    warn: out.filter((f) => f.severity === "warn").length,
    info: out.filter((f) => f.severity === "info").length,
    total: out.length,
  };
  return { month: label, prevMonth: m1.toISOString().slice(0, 7), hasPrev, summary, findings: out };
}

/** 按讀者權限剝明細：缺任何 `requires` module 嘅 view 就只保留數量。純函數（有單元測試）。 */
export function redactMonthHealth(health: MonthHealth, canView: (module: string) => boolean): MonthHealth {
  return {
    ...health,
    findings: health.findings.map((f) => {
      const allowed = f.requires.every((m) => canView(m));
      return allowed ? f : { ...f, detail: null, detailTruncated: false, detailWithheld: true };
    }),
  };
}

/** 一鍵結算報告帶嘅摘要——淨係類別碼＋數量，冇明細冇姓名。 */
export function summarizeHealthForReport(health: MonthHealth): { critical: number; warn: number; info: number; findings: Array<{ code: string; severity: HealthSeverity; count: number }> } {
  return {
    critical: health.summary.critical,
    warn: health.summary.warn,
    info: health.summary.info,
    findings: health.findings.map((f) => ({ code: f.code, severity: f.severity, count: f.count })),
  };
}
