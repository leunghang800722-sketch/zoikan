// P17（老闆 2026-10-14）：病假「更表有 SL mark → 一定要人手確認醫生紙先出 4/5 津貼」。
// 草稿（P9.1）本來就唔計糧（aggregate 只讀 confirmed）＝未確認一律當無薪；呢個檔案負責「主動彈出」所需嘅查詢／通知／決定：
//   - listSlPending：未確認 SL 草稿逐段（日期、連續日數、夠唔夠 4 日提示、結餘、預計津貼金額）
//   - notifySlDraftsPending：通知 kind `sl_drafts_pending`（只有數字，無姓名；dedupe＝月＋草稿 id 集合 hash）
//   - decideSlDraft：逐段「有醫生紙，確認」／「冇醫生紙，當無薪」（後者＝作廢草稿記原因，之後同段唔再生成）
// 唔自動確認任何草稿。
import { createHash } from "node:crypto";
import { excludeUnapprovedWhatsapp } from "./approved-only";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isMonthLocked } from "@/lib/month-lock";
import { monthRange, round2 } from "@/lib/reports/money";
import { createNotification } from "@/lib/notify/create";
import { SL_MIN_CONSECUTIVE, diffDaysInclusive, sl45Payment, slAccrued, slSegmentVerdict, toUtcDate } from "./compute";
import { pickBySourcePriority } from "./attendance-priority";
import { findConfirmedLeaveOverlap, OVERLAP_MSG } from "./drafts";
import type { Prisma } from "@prisma/client";

const SL_DRAFT_SOURCE = "roster_leave:SL";
const DAY = 86400000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface SlPendingSegment {
  id: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  date_from: string;
  date_to: string;
  /** 更表真正 SL 日數（會食結餘／出津貼嗰啲）。 */
  roster_days: number;
  /** 連續日數（date_from–date_to）。 */
  span_days: number;
  /** 夠唔夠 4 日連續（僱傭條例門檻；公司做法已確認醫生紙照出，只係提示）。 */
  meets_consecutive: boolean;
  /** 呢段開始時嘅預計病假結餘（日）。 */
  balance: number;
  within_balance: boolean;
  avg_daily_wage: number | null;
  /** 確認後預計 4/5 津貼；null＝冇平均工資記錄（確認後以日薪 fallback，重算先見）；結餘唔夠＝0。 */
  expected_amount: number | null;
  expected_note: string;
}

export interface SlPendingResult {
  month: string;
  locked: boolean;
  segments: SlPendingSegment[];
  segment_count: number;
  guard_count: number;
}

/** 該月未確認（status=draft、未作廢）嘅更表 SL 草稿。 */
async function listSlPendingDrafts(month: Date) {
  const { start } = monthRange(month);
  return prisma.longtermPayrollInput.findMany({
    where: { month: start, kind: "leave", status: "draft", draftSource: SL_DRAFT_SOURCE, voidedAt: null },
    select: { id: true, guardId: true, dateFrom: true, dateTo: true, draftEvidence: true },
    orderBy: [{ guardId: "asc" }, { dateFrom: "asc" }],
  });
}

/** 輕量計數（鎖月體檢／報告／首頁用）。已鎖月份（包括老闆用「全部當無薪」覆蓋鎖月）一律 0，唔再提示（P18 補充）。 */
export async function countSlPending(month: Date): Promise<{ segments: number; guards: number; ids: string[] }> {
  if (await isMonthLocked(monthRange(month).start)) return { segments: 0, guards: 0, ids: [] };
  const rows = await listSlPendingDrafts(month);
  return { segments: rows.length, guards: new Set(rows.map((r) => r.guardId)).size, ids: rows.map((r) => r.id).sort() };
}

export async function listSlPending(month: Date): Promise<SlPendingResult> {
  const { start, end } = monthRange(month);
  const m = iso(start).slice(0, 7);
  const drafts = await prisma.longtermPayrollInput.findMany({
    where: { month: start, kind: "leave", status: "draft", draftSource: SL_DRAFT_SOURCE, voidedAt: null },
    include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true, hireDate: true } } },
    orderBy: [{ guardId: "asc" }, { dateFrom: "asc" }],
  });
  const base = { month: m, locked: await isMonthLocked(start) };
  if (drafts.length === 0) return { ...base, segments: [], segment_count: 0, guard_count: 0 };

  const guardIds = [...new Set(drafts.map((d) => d.guardId))];
  const [rosterSl, balances, avgWages, confirmed] = await Promise.all([
    // P18 驗收 M1：先跟來源優先次序（連 shift 紀錄比較）再篩 SL，同 aggregate／草稿生成一致。
    prisma.shiftRecord
      .findMany({
        where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: { in: ["shift", "leave"] }, ...excludeUnapprovedWhatsapp() },
        select: { guardId: true, workDate: true, recordType: true, leaveCode: true, source: true, siteId: true },
      })
      .then((rows) => pickBySourcePriority(rows).picked.filter((r) => r.recordType === "leave" && r.leaveCode === "SL")),
    prisma.guardLeaveBalance.findMany({ where: { guardId: { in: guardIds }, year: { lte: start.getUTCFullYear() } }, orderBy: { year: "desc" } }),
    prisma.guardAvgWage.findMany({ where: { guardId: { in: guardIds }, month: start, voidedAt: null } }),
    prisma.longtermPayrollInput.findMany({ where: { month: start, guardId: { in: guardIds }, kind: "leave", status: "confirmed", voidedAt: null, doctorNoteVerified: true }, select: { guardId: true, dateFrom: true, dateTo: true } }),
  ]);
  const slDates = new Map<string, Set<string>>();
  for (const r of rosterSl) {
    const s = slDates.get(r.guardId) ?? new Set<string>();
    s.add(iso(r.workDate));
    slDates.set(r.guardId, s);
  }
  const balByGuard = new Map<string, (typeof balances)[number]>();
  for (const b of balances) if (!balByGuard.has(b.guardId)) balByGuard.set(b.guardId, b);
  const avgByGuard = new Map(avgWages.map((w) => [w.guardId, Number(w.avgDailyWage)]));

  // 同 aggregate.openingLeaveTaken 一致：同月重算用 opening，否則用最新累積。
  function opening(guardId: string): number {
    const b = balByGuard.get(guardId);
    if (!b) return 0;
    if (b.year === start.getUTCFullYear() && b.asOfMonth && b.asOfMonth.getTime() === start.getTime()) return Number(b.slTakenOpening);
    return Number(b.slTaken);
  }

  const segments: SlPendingSegment[] = [];
  const usedByGuard = new Map<string, number>();
  for (const d of drafts) {
    if (!d.dateFrom) continue;
    const from = d.dateFrom;
    const to = d.dateTo ?? d.dateFrom;
    const span = diffDaysInclusive(toUtcDate(from), toUtcDate(to));
    const roster = slDates.get(d.guardId);
    let rosterDays = 0;
    for (let t = toUtcDate(from).getTime(); t <= toUtcDate(to).getTime() && rosterDays < 400; t += DAY) if (roster?.has(iso(new Date(t)))) rosterDays++;
    if (rosterDays === 0) rosterDays = span; // 冇更表對照（例如更表之後改咗）＝保守用全段，同 aggregate fallback 一致
    if (!usedByGuard.has(d.guardId)) {
      // 已確認（有醫生紙）而開始日較早嘅同月病假段，當已食咗結餘
      let used = opening(d.guardId);
      for (const c of confirmed) if (c.guardId === d.guardId && c.dateFrom && c.dateFrom < from) used += diffDaysInclusive(toUtcDate(c.dateFrom), toUtcDate(c.dateTo ?? c.dateFrom));
      usedByGuard.set(d.guardId, used);
    }
    const used = usedByGuard.get(d.guardId)!;
    const hire = d.guard.hireDate;
    const accrued = hire ? slAccrued(toUtcDate(hire), toUtcDate(from)) : 0;
    const balance = round2(accrued - used);
    const within = balance + 1e-9 >= rosterDays;
    const avg = avgByGuard.get(d.guardId) ?? null;
    let expected: number | null;
    let note: string;
    const verdict = slSegmentVerdict(rosterDays, span, balance, true);
    if (!verdict.qualifies) {
      expected = 0;
      note = `確認醫生紙後仍唔出津貼：${verdict.reason}`;
    } else if (avg == null) {
      expected = null;
      note = "未有平均工資記錄——確認後按日薪 fallback，撳「重算本月」先見金額";
    } else {
      expected = sl45Payment(avg, rosterDays);
      note = `平均工資 ${avg} × 0.8 × ${rosterDays} 日（預計；以重算結果為準）`;
    }
    // 假設呢段確認，下一段食咗佢嘅結餘（預計用）
    if (verdict.qualifies) usedByGuard.set(d.guardId, used + rosterDays);
    segments.push({
      id: d.id,
      guard_id: d.guardId,
      guard_name: d.guard.nameZh,
      guard_staff_no: d.guard.staffNo ?? d.guard.staffNoMw ?? null,
      date_from: from,
      date_to: to,
      roster_days: rosterDays,
      span_days: span,
      meets_consecutive: span >= SL_MIN_CONSECUTIVE,
      balance,
      within_balance: within,
      avg_daily_wage: avg,
      expected_amount: expected,
      expected_note: note,
    });
  }
  return { ...base, segments, segment_count: segments.length, guard_count: new Set(segments.map((s) => s.guard_id)).size };
}

/** 通知 dedupe 用：月＋草稿 id 集合 hash（集合變咗＝新通知；同一集合只出一次）。 */
export function slPendingDedupeKey(month: string, ids: string[]): string {
  return `sl_drafts_pending:${month}:${createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 12)}`;
}

/** 有未確認 SL 草稿就發「N 段病假要你確認醫生紙（M 人）」通知（老闆＋會計）。冇就唔發。body 只有數字／月份。 */
export async function notifySlDraftsPending(month: Date): Promise<{ notified: boolean; segments: number; guards: number }> {
  const { start } = monthRange(month);
  const m = iso(start).slice(0, 7);
  const c = await countSlPending(start);
  if (c.segments === 0) return { notified: false, segments: 0, guards: 0 };
  const r = await createNotification({
    kind: "sl_drafts_pending",
    title: `${m} ${c.segments} 段病假要你確認醫生紙（${c.guards} 人）`,
    body: `${m} 更表有 ${c.segments} 段病假（${c.guards} 人）要你確認有冇醫生紙——未確認唔會出津貼，一律當無薪。撳去長工糧 › 人手輸入逐段處理。`,
    href: `/reports/longterm-payroll?month=${m}&focus=sl-drafts`,
    audience: ["老闆", "會計"],
    dedupeKey: slPendingDedupeKey(m, c.ids),
  });
  return { notified: r.created, segments: c.segments, guards: c.guards };
}

export type SlDecision = "confirm" | "unpaid";

export class SlDecisionError extends Error {
  constructor(
    public code: "not_found" | "not_sl_draft" | "overlap",
    message: string,
  ) {
    super(message);
  }
}

/** 逐段決定。confirm＝醫生紙已核實＋確認（計糧）；unpaid＝作廢草稿（記原因、之後同段唔再生成）→ 當無薪。 */
export async function decideSlDraft(id: string, decision: SlDecision, reason: string | null, actorUserId: string, ip: string | null) {
  const before = await prisma.longtermPayrollInput.findUnique({ where: { id } });
  if (!before) throw new SlDecisionError("not_found", "搵唔到呢條草稿");
  if (before.voidedAt || before.status !== "draft" || before.draftSource !== SL_DRAFT_SOURCE || before.kind !== "leave") throw new SlDecisionError("not_sl_draft", "唔係待確認嘅病假草稿（可能已處理）");
  if (decision === "confirm") {
    if (await findConfirmedLeaveOverlap(before.guardId, before.month, before.dateFrom, before.dateTo, id)) throw new SlDecisionError("overlap", OVERLAP_MSG);
    const after = await prisma.longtermPayrollInput.update({
      where: { id },
      data: { status: "confirmed", confirmedAt: new Date(), confirmedBy: actorUserId, doctorNoteVerified: true, note: `${before.note ? `${before.note}；` : ""}醫生紙已人手確認` },
    });
    await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: id, action: "update", before, after, ip });
    return after;
  }
  const ev = before.draftEvidence && typeof before.draftEvidence === "object" && !Array.isArray(before.draftEvidence) ? (before.draftEvidence as Record<string, unknown>) : {};
  const after = await prisma.longtermPayrollInput.update({
    where: { id },
    data: { voidedAt: new Date(), voidedBy: actorUserId, draftEvidence: { ...ev, decline_reason: (reason?.trim() || "冇醫生紙，當無薪").slice(0, 200) } as Prisma.InputJsonValue },
  });
  await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: id, action: "void", before, after, ip });
  return after;
}
