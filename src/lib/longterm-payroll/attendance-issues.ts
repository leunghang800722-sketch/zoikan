// P18.2：長工糧「出勤修正」面板資料——① 同日多來源衝突日；② 全部更歸雞頭（settlement≠B07）嘅長工。
// 唯讀（寫入一律走 POST /api/shift-records/batch）。姓名只喺回應內，通知／日誌唔含。
import { prisma } from "@/lib/db";
import { isMonthLocked } from "@/lib/month-lock";
import { findInternalLongtermBrokerId } from "@/lib/pricing/longterm-settlement";
import { pickBySourcePriority, sourceLabel, sourceRank } from "./attendance-priority";

export type AttendanceEffect = "work" | "paid" | "unpaid" | "rest";

/** 代號對糧嘅影響（只描述，唔係計算）：返工／有薪（AL、SH、SL 按病假規則）／無薪（NL）／例假（RD）。 */
function effectOfCode(code: string): { effect: AttendanceEffect; label: string } {
  if (code === "班") return { effect: "work", label: "返工（計返工日）" };
  if (code === "NL" || code === "NPL") return { effect: "unpaid", label: "無薪（扣薪）" };
  if (code === "RD" || code === "OFF") return { effect: "rest", label: "例假（唔計返工日）" };
  if (code === "SL") return { effect: "paid", label: "病假（按 4/5 病假規則）" };
  if (code === "SH") return { effect: "paid", label: "法定假（有薪）" };
  if (code === "AL") return { effect: "paid", label: "年假（有薪）" };
  return { effect: "paid", label: "有薪" };
}

interface AttendanceConflictEntry {
  source: string;
  code: string; // "班"／LeaveCode；同來源同日多條以「＋」相連
  rank: number;
}
export interface AttendanceConflictRow {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  date: string; // YYYY-MM-DD
  entries: AttendanceConflictEntry[];
  adopted_source: string;
  adopted_code: string;
  effect: AttendanceEffect;
  effect_label: string;
  /** 寫入目標：該日最高來源紀錄（最近更新者）嘅 site／shift_type／代號——「採用／設為」經 batch API 寫呢格。 */
  target: { site_id: string; shift_type_id: string; shift_type_code: string };
  /** 可「採用」嘅代號：各來源已有代號（當中「班」＝目標 shift_type 嘅更別代號）。 */
  options: Array<{ code: string; source: string; batch_code: string; effect: AttendanceEffect; effect_label: string }>;
}
export interface MisattributedGuardRow {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  shift_days: number;
  settlement_broker_codes: string[];
  /** 現時被當頂位更（settlement≠B07）、要改歸 B07 嘅格。 */
  cells: Array<{ site_id: string; shift_type_id: string; shift_type_code: string; date: string }>;
}
export interface AttendanceIssues {
  month: string;
  locked: boolean;
  internal_longterm_broker_id: string | null;
  conflicts: AttendanceConflictRow[];
  misattributed: MisattributedGuardRow[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function listAttendanceIssues(month: Date): Promise<AttendanceIssues> {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  const base = { month: iso(start).slice(0, 7), locked: await isMonthLocked(start) };
  const b07 = await findInternalLongtermBrokerId();
  const contracts = await prisma.guardLongtermContract.findMany({
    where: { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    select: { guardId: true },
  });
  const guardIds = [...new Set(contracts.map((c) => c.guardId))];
  if (guardIds.length === 0) return { ...base, internal_longterm_broker_id: b07, conflicts: [], misattributed: [] };

  const [guards, records] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, nameZh: true, staffNo: true, staffNoMw: true, visaSponsoredByBrokerId: true } }),
    prisma.shiftRecord.findMany({
      where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" } },
      select: {
        id: true, guardId: true, workDate: true, recordType: true, leaveCode: true, source: true, siteId: true, shiftTypeId: true,
        settlementBrokerId: true, updatedAt: true, shiftType: { select: { code: true } }, settlementBroker: { select: { code: true } },
      },
    }),
  ]);
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const byGuard = new Map<string, typeof records>();
  for (const r of records) {
    const arr = byGuard.get(r.guardId) ?? [];
    arr.push(r);
    byGuard.set(r.guardId, arr);
  }

  const conflicts: AttendanceConflictRow[] = [];
  const misattributed: MisattributedGuardRow[] = [];
  for (const gid of guardIds) {
    const g = guardById.get(gid);
    const recs = byGuard.get(gid) ?? [];
    if (!g || recs.length === 0) continue;
    const common = { guard_id: gid, guard_name: g.nameZh, guard_staff_no: g.staffNo ?? g.staffNoMw ?? null };

    // ② 全部更歸雞頭：有正更、無任何一條正更歸 B07／冇結算單位；簽證形式長工（規則 12）本來就歸贊助雞頭，唔列。
    const shifts = recs.filter((r) => r.recordType === "shift");
    if (b07 && !g.visaSponsoredByBrokerId && shifts.length > 0 && shifts.every((r) => r.settlementBrokerId !== null && r.settlementBrokerId !== b07)) {
      misattributed.push({
        ...common,
        shift_days: new Set(shifts.map((r) => iso(r.workDate))).size,
        settlement_broker_codes: [...new Set(shifts.map((r) => r.settlementBroker?.code ?? "?"))].sort(),
        cells: shifts.map((r) => ({ site_id: r.siteId, shift_type_id: r.shiftTypeId, shift_type_code: r.shiftType.code, date: iso(r.workDate) })).sort((a, b) => a.date.localeCompare(b.date)),
      });
    }

    // ① 同日多來源衝突（≥2 個來源而且出勤代號唔一致；OT 唔計）
    const att = recs.filter((r) => r.recordType === "shift" || (r.recordType === "leave" && r.leaveCode));
    const byDate = new Map<string, typeof att>();
    for (const r of att) {
      const d = iso(r.workDate);
      const arr = byDate.get(d) ?? [];
      arr.push(r);
      byDate.set(d, arr);
    }
    const { adoptions } = pickBySourcePriority(att);
    for (const d of [...byDate.keys()].sort()) {
      const day = byDate.get(d)!;
      const codeOf = (r: (typeof day)[number]) => (r.recordType === "shift" ? "班" : r.leaveCode!);
      const bySrc = new Map<string, Set<string>>();
      for (const r of day) {
        const s = sourceLabel(r.source);
        const set = bySrc.get(s) ?? new Set<string>();
        set.add(codeOf(r));
        bySrc.set(s, set);
      }
      if (bySrc.size < 2) continue;
      const sigs = [...bySrc.entries()].map(([source, set]) => ({ source, code: [...set].sort().join("＋"), rank: sourceRank(source === sourceLabel(null) ? null : source) }));
      if (new Set(sigs.map((x) => x.code)).size < 2) continue;
      sigs.sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source));
      const bestRank = Math.min(...day.map((r) => sourceRank(r.source)));
      const top = day.filter((r) => sourceRank(r.source) === bestRank).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
      const adoptedCode = [...new Set(day.filter((r) => sourceRank(r.source) === bestRank).map(codeOf))].sort().join("＋");
      const eff = effectOfCode(adoptedCode.includes("＋") ? adoptedCode.split("＋")[0]! : adoptedCode);
      const opts: AttendanceConflictRow["options"] = [];
      for (const r of day) {
        const code = codeOf(r);
        if (opts.some((o) => o.code === code)) continue;
        const e = effectOfCode(code);
        opts.push({ code, source: sourceLabel(r.source), batch_code: code === "班" ? top.shiftType.code : code, effect: e.effect, effect_label: e.label });
      }
      conflicts.push({
        ...common,
        date: d,
        entries: sigs,
        adopted_source: adoptions.get(d)?.adopted ?? sourceLabel(top.source),
        adopted_code: adoptedCode,
        effect: eff.effect,
        effect_label: eff.label,
        target: { site_id: top.siteId, shift_type_id: top.shiftTypeId, shift_type_code: top.shiftType.code },
        options: opts,
      });
    }
  }
  conflicts.sort((a, b) => a.guard_name.localeCompare(b.guard_name) || a.date.localeCompare(b.date));
  misattributed.sort((a, b) => a.guard_name.localeCompare(b.guard_name));
  return { ...base, internal_longterm_broker_id: b07, conflicts, misattributed };
}
