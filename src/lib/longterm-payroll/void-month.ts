// P15.1：作廢長工糧某月計算（倒序重算）。只准作廢「最近一個已計月份」；同時將假期結餘回滾到計呢個月之前嘅狀態：
//  - 有快照（`guard_leave_balance_history`，P15 起每次寫回前影低）→ 原樣還原（existed=false → 刪除結餘記錄；
//    但該行而家有人手 al_entitled／al_carry 非 0 → 唔刪，taken 回到 opening（上年結轉）、as_of_month 清空，計入 kept_manual_rows；opening 非 0 唔算人手）。
//  - 冇快照（P15 前計過嘅月份，legacy）→ taken＝該行 `*_opening`（即上月尾累積）。
//      · 冇更早有效 run：空殼行（opening／entitled／carry 全 0）刪除；其餘 taken 回 opening、as_of_month＝null（精確）。
//      · 有更早有效 run 而且同年：as_of_month 回到上一個有效 run 月份，上月 opening ＝ 上月尾累積 − 上月新增
//        （以 0 起算 dry-run 重建上月攞到嘅日數）——近似（`approx_rebuild`），要用戶額外確認（confirm_approx）。
//      · 有更早 run 但跨年：taken 回 opening、as_of_month＝null（精確）。
// 同時清走該月 source 以 computed／auto:／自動計: 開頭嘅平均工資（只認前綴）；人手（manual:…）保留。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest, Conflict, NotFound, ApiError } from "@/lib/api/errors";
import { monthLabel, n, round2 } from "@/lib/reports/money";
import { buildLongtermPayrollInputs } from "./aggregate";
import { assertMonthNotLockedTx, monthStart } from "@/lib/month-lock";

const COMPUTED_AVG_SOURCE_PREFIXES = ["computed", "auto:", "自動計:"] as const;

type RollbackMethod = "none" | "snapshot" | "exact_rebuild" | "approx_rebuild";

export interface VoidMonthResult {
  month: string;
  voided_runs: number;
  balances_restored: number;
  balances_deleted: number;
  kept_manual_rows: number;
  legacy_rebuilt: number;
  avg_wages_cleared: number;
  restored_as_of_month: string | null;
  rollback_method: RollbackMethod;
}

export interface VoidPreview {
  month: string;
  has_run: boolean;
  /** 該月之前仲有效嘅 run 月份（YYYY-MM，升序） */
  earlier_valid_runs: string[];
  /** 後面仲有效嘅月份（有就唔可以作廢） */
  later_blockers: string[];
  rollback_method: RollbackMethod;
  needs_confirm_approx: boolean;
  affected_guards: number;
}

type BalRow = { id: string; guardId: string; year: number; alTakenOpening: unknown; slTakenOpening: unknown; alEntitled: unknown; alCarry: unknown; slAccrued: unknown };

function isEmptyShell(r: BalRow) {
  return n(r.alTakenOpening as never) === 0 && n(r.slTakenOpening as never) === 0 && n(r.alEntitled as never) === 0 && n(r.alCarry as never) === 0;
}

function classify(rows: BalRow[], snappedKeys: Set<string>, prevMonth: Date | null): { method: RollbackMethod; legacy: number; approx: number } {
  let legacy = 0;
  let approx = 0;
  for (const r of rows) {
    if (snappedKeys.has(`${r.guardId}|${r.year}`)) continue;
    legacy += 1;
    if (prevMonth && prevMonth.getUTCFullYear() === r.year) approx += 1;
  }
  const method: RollbackMethod = approx > 0 ? "approx_rebuild" : legacy > 0 ? "exact_rebuild" : rows.length > 0 || snappedKeys.size > 0 ? "snapshot" : "none";
  return { method, legacy, approx };
}

async function loadContext(month: Date) {
  const [runs, earlier, later, laterBal, snaps, rows] = await Promise.all([
    prisma.longtermPayrollRun.findMany({ where: { month, voidedAt: null, status: { not: "void" } }, select: { id: true } }),
    prisma.longtermPayrollRun.findMany({ where: { month: { lt: month }, voidedAt: null, status: { not: "void" } }, select: { month: true }, distinct: ["month"], orderBy: { month: "asc" } }),
    prisma.longtermPayrollRun.findMany({ where: { month: { gt: month }, voidedAt: null, status: { not: "void" } }, select: { month: true }, distinct: ["month"], orderBy: { month: "asc" } }),
    prisma.guardLeaveBalance.findFirst({ where: { asOfMonth: { gt: month } }, select: { asOfMonth: true } }),
    prisma.guardLeaveBalanceHistory.findMany({ where: { month }, select: { guardId: true, year: true } }),
    prisma.guardLeaveBalance.findMany({ where: { asOfMonth: month }, select: { id: true, guardId: true, year: true, alTakenOpening: true, slTakenOpening: true, alEntitled: true, alCarry: true, slAccrued: true } }),
  ]);
  const prevMonth = earlier.length ? earlier[earlier.length - 1]!.month : null;
  return { runs, earlier, later, laterBal, snaps, rows, prevMonth };
}

/** 唯讀前置檢查（UI 作廢對話框用）。 */
export async function previewVoidLongtermPayrollMonth(monthIn: Date): Promise<VoidPreview> {
  const month = monthStart(monthIn);
  const c = await loadContext(month);
  const laterList = [...c.later.map((l) => monthLabel(l.month)), ...(c.laterBal?.asOfMonth ? [monthLabel(c.laterBal.asOfMonth)] : [])];
  const snappedKeys = new Set(c.snaps.map((s) => `${s.guardId}|${s.year}`));
  const cls = classify(c.rows as BalRow[], snappedKeys, c.prevMonth);
  const affected = new Set([...c.rows.map((r) => r.guardId), ...c.snaps.map((s) => s.guardId)]).size;
  return {
    month: monthLabel(month),
    has_run: c.runs.length > 0,
    earlier_valid_runs: c.earlier.map((e) => monthLabel(e.month)),
    later_blockers: [...new Set(laterList)],
    rollback_method: cls.method,
    needs_confirm_approx: cls.approx > 0,
    affected_guards: affected,
  };
}

export async function voidLongtermPayrollMonth(monthIn: Date, actorUserId: string, reason: string, ip: string | null = null, opts: { confirmApprox?: boolean } = {}): Promise<VoidMonthResult> {
  const month = monthStart(monthIn);
  const why = reason.trim();
  if (!why) throw BadRequest("作廢原因必填");

  const pre = await loadContext(month);
  const prevMonth = pre.prevMonth;
  const preCls = classify(pre.rows as BalRow[], new Set(pre.snaps.map((s) => `${s.guardId}|${s.year}`)), prevMonth);
  if (preCls.approx > 0 && !opts.confirmApprox) {
    throw new ApiError(409, "approx_rollback_requires_confirm", `有 ${preCls.approx} 人嘅假期結餘冇快照（P15 前計過），回滾要近似重建上月起算數。請確認後帶 confirm_approx:true 再作廢，作廢後請抽查 AL／SL 已放日數`, { rollback_method: "approx_rebuild", approx_guards: preCls.approx });
  }
  // legacy 近似重建要用上月「新增」日數（tx 外純讀取 build）
  const delta = new Map<string, { al: number; sl: number; acc: number }>();
  if (preCls.approx > 0 && prevMonth) {
    const b = await buildLongtermPayrollInputs(prevMonth, prisma, { zeroOpening: true });
    for (const l of b.lines) delta.set(l.guardId, { al: l.leaveBalanceWriteback.alTakenCumulative, sl: l.leaveBalanceWriteback.slTakenCumulative, acc: l.leaveBalanceWriteback.slAccruedAtMonthEnd });
  }

  return prisma.$transaction(
    async (tx) => {
      await assertMonthNotLockedTx(tx, { workDate: month, actorUserId, tableName: "longterm_payroll_runs", rowId: "void", ip });
      const runs = await tx.longtermPayrollRun.findMany({ where: { month, voidedAt: null, status: { not: "void" } }, select: { id: true } });
      if (runs.length === 0) throw NotFound(`${monthLabel(month)} 冇可作廢嘅長工糧計算`);
      const laterRun = await tx.longtermPayrollRun.findFirst({ where: { month: { gt: month }, voidedAt: null, status: { not: "void" } }, orderBy: { month: "desc" }, select: { month: true } });
      const laterBal = await tx.guardLeaveBalance.findFirst({ where: { asOfMonth: { gt: month } }, select: { asOfMonth: true } });
      const later = laterRun?.month ?? laterBal?.asOfMonth;
      if (later) throw Conflict(`${monthLabel(later)} 嘅長工糧已經計過，要先作廢 ${monthLabel(later)}，先可以作廢 ${monthLabel(month)}（只准由最近一個月逐個倒序作廢）`);

      await tx.longtermPayrollRun.updateMany({ where: { id: { in: runs.map((r) => r.id) } }, data: { voidedAt: new Date(), voidedBy: actorUserId, status: "void" } });

      const snaps = await tx.guardLeaveBalanceHistory.findMany({ where: { month } });
      const key = (g: string, y: number) => `${g}|${y}`;
      const rows = await tx.guardLeaveBalance.findMany({ where: { asOfMonth: month } });
      const guardsAffected = new Set<string>();
      let restored = 0;
      let deleted = 0;
      let kept = 0;
      let legacy = 0;
      const done = new Set<string>();
      for (const s of snaps) {
        done.add(key(s.guardId, s.year));
        guardsAffected.add(s.guardId);
        const cur = await tx.guardLeaveBalance.findUnique({ where: { guardId_year: { guardId: s.guardId, year: s.year } } });
        if (!s.existed) {
          if (!cur) continue;
          // 同年 existed=false ＝ 計算前冇本年行；opening 非 0 只可能係上年結轉（唔係人手），所以只睇人手 entitled／carry。
          if (n(cur.alEntitled) !== 0 || n(cur.alCarry) !== 0) {
            // 有人手 entitled／carry → 唔刪行；taken 回到 opening（＝計算前讀到嘅上年累積），唔係 0（否則上年結轉會冇咗）
            await tx.guardLeaveBalance.update({ where: { id: cur.id }, data: { alTaken: cur.alTakenOpening, slTaken: cur.slTakenOpening, asOfMonth: null } });
            kept += 1;
          } else {
            await tx.guardLeaveBalance.delete({ where: { id: cur.id } });
            deleted += 1;
          }
        } else {
          await tx.guardLeaveBalance.updateMany({
            where: { guardId: s.guardId, year: s.year },
            data: { alTaken: s.alTaken, slTaken: s.slTaken, slAccrued: s.slAccrued, asOfMonth: s.asOfMonth, alTakenOpening: s.alTakenOpening, slTakenOpening: s.slTakenOpening },
          });
          restored += 1;
        }
      }
      for (const r of rows) {
        if (done.has(key(r.guardId, r.year))) continue;
        guardsAffected.add(r.guardId);
        legacy += 1;
        // 系統首次計算（冇更早有效 run）而個行只係計糧寫出嚟嘅空殼 → 計糧之前呢行根本唔存在，精確做法係刪除
        if (!prevMonth && isEmptyShell(r as unknown as BalRow)) {
          await tx.guardLeaveBalance.delete({ where: { id: r.id } });
          deleted += 1;
          continue;
        }
        const alEnd = n(r.alTakenOpening);
        const slEnd = n(r.slTakenOpening);
        const samePrev = prevMonth && prevMonth.getUTCFullYear() === r.year ? prevMonth : null;
        const d = delta.get(r.guardId) ?? { al: 0, sl: 0, acc: n(r.slAccrued) };
        const data = samePrev
          ? { alTaken: alEnd, slTaken: slEnd, slAccrued: d.acc, asOfMonth: samePrev, alTakenOpening: Math.max(0, round2(alEnd - d.al)), slTakenOpening: Math.max(0, round2(slEnd - d.sl)) }
          : { alTaken: alEnd, slTaken: slEnd, asOfMonth: null, alTakenOpening: alEnd, slTakenOpening: slEnd };
        await tx.guardLeaveBalance.update({ where: { id: r.id }, data });
        restored += 1;
      }
      await tx.guardLeaveBalanceHistory.deleteMany({ where: { month } });

      const cleared = (await tx.guardAvgWage.deleteMany({ where: { month, OR: COMPUTED_AVG_SOURCE_PREFIXES.map((p) => ({ source: { startsWith: p } })) } })).count;

      const method: RollbackMethod = preCls.approx > 0 ? "approx_rebuild" : legacy > 0 ? "exact_rebuild" : snaps.length > 0 || rows.length > 0 ? "snapshot" : "none";
      await writeAuditTx(tx, {
        actorUserId,
        tableName: "longterm_payroll_runs",
        rowId: runs[0]!.id,
        action: "void_longterm_payroll_month",
        before: { month: monthLabel(month), run_ids: runs.map((r) => r.id), guards_affected: guardsAffected.size },
        after: { reason: why.slice(0, 500), rollback_method: method, balances_restored: restored, balances_deleted: deleted, kept_manual_rows: kept, legacy_rebuilt: legacy, avg_wages_cleared: cleared, confirm_approx: !!opts.confirmApprox },
        ip,
      });
      return { month: monthLabel(month), voided_runs: runs.length, balances_restored: restored, balances_deleted: deleted, kept_manual_rows: kept, legacy_rebuilt: legacy, avg_wages_cleared: cleared, restored_as_of_month: prevMonth ? monthLabel(prevMonth) : null, rollback_method: method };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
