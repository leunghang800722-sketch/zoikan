// P9.1：長工糧人手輸入「草稿」。老闆規則：唔准自動加任何金額——草稿唔帶金額、未確認唔計糧（aggregate 只讀 status=confirmed）。
// 只對「aggregate 仍然要人手開 input」嘅項目做草稿：
//   - SL：更表有 SL 日子，但 4/5 判定要會計開病假段＋核醫生紙（冇就當無薪假扣）→ 生成 kind=leave 草稿（連續日期合成一段、醫生紙＝未核）。
//   - AL／NL／NPL／SH：aggregate 已由更表自動計（AL 在職只記日數、離職自動結算；NL／NPL 自動扣日薪）→ 唔生成（見 docs/ P3 §13.1 對照表）。
//   - 勤工獎：只出「合資格清單」，唔建 input、唔填金額。
// 鎖月月份唔生成。經 prisma＋writeAudit（job 內自動帶 by_job）。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { pickBySourcePriority } from "./attendance-priority";
import { isMonthLocked } from "@/lib/month-lock";
import { monthRange } from "@/lib/reports/money";
import { getSystemUserId } from "@/lib/system-user";
import { toUtcDate } from "./compute";
import type { Prisma } from "@prisma/client";

const DRAFT_SOURCE_SL = "roster_leave:SL";
const DAY = 86400000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface DraftEvidence {
  dates: string[];
  roster_upload_ids: string[];
  edited?: boolean;
}

/** 連續日期（逐日 +1）合成段。 */
export function groupConsecutive(sortedDates: string[]): string[][] {
  const out: string[][] = [];
  for (const d of sortedDates) {
    const last = out[out.length - 1];
    if (last && toUtcDate(d).getTime() - toUtcDate(last[last.length - 1]).getTime() === DAY) last.push(d);
    else out.push([d]);
  }
  return out;
}

function evidenceOf(v: Prisma.JsonValue | null): DraftEvidence | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    dates: Array.isArray(o.dates) ? (o.dates as unknown[]).filter((x): x is string => typeof x === "string") : [],
    roster_upload_ids: Array.isArray(o.roster_upload_ids) ? (o.roster_upload_ids as unknown[]).filter((x): x is string => typeof x === "string") : [],
    edited: o.edited === true,
  };
}

function datesOfRange(from: string, to: string | null): string[] {
  const a = toUtcDate(from).getTime();
  const b = to ? toUtcDate(to).getTime() : a;
  const out: string[] = [];
  for (let t = a; t <= b && out.length < 400; t += DAY) out.push(iso(new Date(t)));
  return out;
}

/** M1：同 guard／月、未作廢、已確認、kind=leave 且日期段重疊嘅輸入（確認草稿／新增病假段前檢查，防重複扣款）。 */
export async function findConfirmedLeaveOverlap(guardId: string, month: Date, from: string | null, to: string | null, excludeId?: string, db: Pick<Prisma.TransactionClient, "longtermPayrollInput"> = prisma): Promise<string | null> {
  if (!from) return null;
  const a = from;
  const b = to ?? from;
  const rows = await db.longtermPayrollInput.findMany({ where: { guardId, month, kind: "leave", status: "confirmed", voidedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true, dateFrom: true, dateTo: true } });
  const hit = rows.find((r) => r.dateFrom && r.dateFrom <= b && (r.dateTo ?? r.dateFrom) >= a);
  return hit?.id ?? null;
}

export const OVERLAP_MSG = "同已確認病假段重疊";

export interface DraftMonthResult {
  month: string;
  locked: boolean;
  created: number;
  updated: number;
  voided: number;
  rejected_skipped: number;
  mismatches: number;
  pending: number;
}

/** 某月（未鎖）由更表 SL 日子生成／更新病假段草稿。冪等。 */
export async function generateLongtermInputDrafts(month: Date, actorUserId: string): Promise<DraftMonthResult> {
  const { start, end } = monthRange(month);
  const m = iso(start).slice(0, 7);
  const res: DraftMonthResult = { month: m, locked: false, created: 0, updated: 0, voided: 0, rejected_skipped: 0, mismatches: 0, pending: 0 };
  if (await isMonthLocked(start)) return { ...res, locked: true };

  const contracts = await prisma.guardLongtermContract.findMany({
    where: { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    select: { guardId: true },
  });
  const guardIds = [...new Set(contracts.map((c) => c.guardId))];
  if (guardIds.length === 0) return res;

  // P18 驗收 M1：SL 日子要先跟來源優先次序（同 aggregate）——連 shift 紀錄一齊比較，最高來源有班就唔當 SL。
  const attRows = await prisma.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: { in: ["shift", "leave"] } },
    select: { guardId: true, workDate: true, provenance: true, recordType: true, leaveCode: true, source: true, siteId: true },
  });
  const slRows = pickBySourcePriority(attRows).picked.filter((r) => r.recordType === "leave" && r.leaveCode === "SL");
  const slByGuard = new Map<string, Map<string, string | null>>();
  for (const r of slRows) {
    const mp = slByGuard.get(r.guardId) ?? new Map<string, string | null>();
    const up = r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? (r.provenance as Record<string, unknown>).upload_id : null;
    mp.set(iso(r.workDate), typeof up === "string" ? up : null);
    slByGuard.set(r.guardId, mp);
  }

  const existing = await prisma.longtermPayrollInput.findMany({ where: { month: start, kind: "leave", guardId: { in: guardIds } } });
  const existingByGuard = new Map<string, typeof existing>();
  for (const e of existing) {
    const arr = existingByGuard.get(e.guardId) ?? [];
    arr.push(e);
    existingByGuard.set(e.guardId, arr);
  }
  const sysId = await getSystemUserId();

  for (const guardId of guardIds) {
    const rosterSl = slByGuard.get(guardId) ?? new Map<string, string | null>();
    const rows = existingByGuard.get(guardId) ?? [];
    const live = rows.filter((r) => !r.voidedAt);
    const confirmed = live.filter((r) => r.status === "confirmed");
    const drafts = live.filter((r) => r.status === "draft" && r.draftSource === DRAFT_SOURCE_SL);

    // (1) 已確認嘅草稿來源輸入，而家更表 SL 日子同確認時唔同 → 只通知，唔郁
    for (const c of confirmed) {
      if (c.draftSource !== DRAFT_SOURCE_SL || !c.dateFrom) continue;
      const ev = evidenceOf(c.draftEvidence);
      if (!ev || ev.edited) continue; // 會計改過日期再確認嘅，唔再同更表原始日期比對
      const nowDates = datesOfRange(c.dateFrom, c.dateTo).filter((d) => rosterSl.has(d));
      if (nowDates.join(",") !== ev.dates.join(",")) res.mismatches++;
    }

    // (2) 已被已確認／人手編輯過嘅輸入覆蓋咗嘅日子，唔再出草稿
    const covered = new Set<string>();
    for (const c of confirmed) if (c.dateFrom) for (const d of datesOfRange(c.dateFrom, c.dateTo)) covered.add(d);
    for (const d of drafts) {
      if (evidenceOf(d.draftEvidence)?.edited && d.dateFrom) for (const x of datesOfRange(d.dateFrom, d.dateTo)) covered.add(x);
    }
    const desiredDates = [...rosterSl.keys()].filter((d) => !covered.has(d)).sort();
    const desired = groupConsecutive(desiredDates).map((dates) => ({
      dates,
      uploads: [...new Set(dates.map((d) => rosterSl.get(d)).filter((x): x is string => !!x))].sort(),
    }));

    // (3) 會計刪走（作廢者唔係系統）嘅草稿 → 同一組日期唔再出
    const rejectedKeys = new Set(
      rows
        .filter((r) => r.voidedAt && r.status === "draft" && r.draftSource === DRAFT_SOURCE_SL && r.voidedBy !== sysId)
        .map((r) => (evidenceOf(r.draftEvidence)?.dates ?? []).join(",")),
    );
    const wanted = desired.filter((d) => {
      if (rejectedKeys.has(d.dates.join(","))) {
        res.rejected_skipped++;
        return false;
      }
      return true;
    });

    // (4) 對賬：未編輯嘅現有草稿 vs wanted
    const editable = drafts.filter((d) => !evidenceOf(d.draftEvidence)?.edited).sort((a, b) => ((a.dateFrom ?? "") < (b.dateFrom ?? "") ? -1 : 1));
    const keyOf = (dates: string[]) => dates.join(",");
    const unmatchedWanted = wanted.filter((w) => !editable.some((e) => keyOf(evidenceOf(e.draftEvidence)?.dates ?? []) === keyOf(w.dates)));
    const unmatchedExisting = editable.filter((e) => !wanted.some((w) => keyOf(w.dates) === keyOf(evidenceOf(e.draftEvidence)?.dates ?? [])));

    const pairs = Math.min(unmatchedWanted.length, unmatchedExisting.length);
    for (let i = 0; i < pairs; i++) {
      const w = unmatchedWanted[i];
      const e = unmatchedExisting[i];
      const evidence: DraftEvidence = { dates: w.dates, roster_upload_ids: w.uploads };
      const after = await prisma.longtermPayrollInput.update({ where: { id: e.id }, data: { dateFrom: w.dates[0], dateTo: w.dates[w.dates.length - 1], draftEvidence: evidence as unknown as Prisma.InputJsonValue } });
      await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: e.id, action: "update", before: e, after, ip: null });
      res.updated++;
    }
    for (const w of unmatchedWanted.slice(pairs)) {
      const evidence: DraftEvidence = { dates: w.dates, roster_upload_ids: w.uploads };
      const created = await prisma.longtermPayrollInput.create({
        data: {
          month: start,
          guardId,
          kind: "leave",
          dateFrom: w.dates[0],
          dateTo: w.dates[w.dates.length - 1],
          doctorNoteVerified: false,
          note: "病假段（醫生紙待核）——由更表 SL 自動生成草稿",
          status: "draft",
          draftSource: DRAFT_SOURCE_SL,
          draftEvidence: evidence as unknown as Prisma.InputJsonValue,
          createdBy: actorUserId,
        },
      });
      await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: created.id, action: "create", after: created, ip: null });
      res.created++;
    }
    for (const e of unmatchedExisting.slice(pairs)) {
      const after = await prisma.longtermPayrollInput.update({ where: { id: e.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: e.id, action: "void", before: e, after, ip: null });
      res.voided++;
    }
  }
  res.pending = await prisma.longtermPayrollInput.count({ where: { month: start, status: "draft", voidedAt: null } });
  return res;
}

// ---------------------------------------------------------------------------
// 勤工獎合資格清單（唔建 input、唔填金額）
// 規則：該月有長工合約嘅人，更表冇 SL、NL、NPL（系統冇遲到紀錄，所以遲到未能核對——頁面同通知都寫明）。
// ---------------------------------------------------------------------------
const DISQUALIFY_CODES = ["SL", "NL", "NPL"] as const;

export interface BonusEligible {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  already_filled: boolean;
}

export async function listAttendanceBonusEligible(month: Date): Promise<{ month: string; eligible: BonusEligible[]; late_checked: false }> {
  const { start, end } = monthRange(month);
  const contracts = await prisma.guardLongtermContract.findMany({
    where: { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    select: { guardId: true },
  });
  const guardIds = [...new Set(contracts.map((c) => c.guardId))];
  const base = { month: iso(start).slice(0, 7), late_checked: false as const };
  if (guardIds.length === 0) return { ...base, eligible: [] };
  const [bad, filled, guards] = await Promise.all([
    // P18 驗收 M5：先跟來源優先次序，被忽略來源嘅 SL／NL 唔令人失去資格。
    prisma.shiftRecord
      .findMany({
        where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: { in: ["shift", "leave"] } },
        select: { guardId: true, workDate: true, recordType: true, leaveCode: true, source: true, siteId: true },
      })
      .then((rows) => pickBySourcePriority(rows).picked.filter((r) => r.recordType === "leave" && (DISQUALIFY_CODES as readonly string[]).includes(r.leaveCode ?? ""))),
    prisma.longtermPayrollInput.groupBy({
      by: ["guardId"],
      where: { month: start, guardId: { in: guardIds }, kind: "special_allowance", status: "confirmed", voidedAt: null },
    }),
    prisma.guard.findMany({ where: { id: { in: guardIds }, status: "active" }, select: { id: true, nameZh: true, staffNo: true, staffNoMw: true }, orderBy: { nameZh: "asc" } }),
  ]);
  const badSet = new Set(bad.map((b) => b.guardId));
  const filledSet = new Set(filled.map((f) => f.guardId));
  const eligible = guards
    .filter((g) => !badSet.has(g.id))
    .map((g) => ({ guard_id: g.id, guard_name: g.nameZh, guard_staff_no: g.staffNo ?? g.staffNoMw ?? null, already_filled: filledSet.has(g.id) }));
  return { ...base, eligible };
}
