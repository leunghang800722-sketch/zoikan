// P15.1：作廢長工糧某月計算（倒序重算）。只准作廢「最近一個已計月份」；同時將假期結餘回滾到計呢個月之前嘅狀態：
//  - 有快照（`guard_leave_balance_history`，P15 起每次寫回前影低）→ 原樣還原（existed=false → 刪除結餘記錄）。
//  - 冇快照（P15 前計過嘅月份，legacy）→ taken＝該行 `*_opening`（即上月尾累積）；asOfMonth 回到上一個仍有效 run 嘅月份，
//    當月 opening 以「上月尾累積 − 上月新增（以 0 起算 dry-run 重建上月攞到嘅日數）」重建。同年先重建；跨年或冇上一個月 → asOfMonth＝null。
//    legacy 重建係近似（上月更表／輸入若之後有改會有偏差），回應 `legacy_rebuilt` 列出數量，ops.md 叫人覆核。
// 同時清走該月 source 係自動計（computed／自動計）嘅平均工資；人手（manual）保留。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest, Conflict, NotFound } from "@/lib/api/errors";
import { monthLabel, n, round2 } from "@/lib/reports/money";
import { buildLongtermPayrollInputs } from "./aggregate";
import { assertMonthNotLockedTx, monthStart } from "@/lib/month-lock";

export interface VoidMonthResult {
  month: string;
  voided_runs: number;
  balances_restored: number;
  balances_deleted: number;
  legacy_rebuilt: number;
  avg_wages_cleared: number;
  restored_as_of_month: string | null;
}

export async function voidLongtermPayrollMonth(monthIn: Date, actorUserId: string, reason: string, ip: string | null = null): Promise<VoidMonthResult> {
  const month = monthStart(monthIn);
  const why = reason.trim();
  if (!why) throw BadRequest("作廢原因必填");

  const prevRun = await prisma.longtermPayrollRun.findFirst({ where: { month: { lt: month }, voidedAt: null, status: { not: "void" } }, orderBy: { month: "desc" }, select: { month: true } });
  const prevMonth = prevRun?.month ?? null;
  // legacy 重建要用上月「新增」日數：只喺有冇快照嘅 asOfMonth=month 行先需要（tx 外純讀取 build）
  const delta = new Map<string, { al: number; sl: number; acc: number }>();
  if (prevMonth) {
    const legacyRows = await prisma.guardLeaveBalance.findMany({ where: { asOfMonth: month, year: prevMonth.getUTCFullYear() }, select: { guardId: true, year: true } });
    if (legacyRows.length > 0) {
      const snapped = new Set((await prisma.guardLeaveBalanceHistory.findMany({ where: { month }, select: { guardId: true, year: true } })).map((s) => `${s.guardId}|${s.year}`));
      if (legacyRows.some((r) => !snapped.has(`${r.guardId}|${r.year}`))) {
        const b = await buildLongtermPayrollInputs(prevMonth, prisma, { zeroOpening: true });
        for (const l of b.lines) delta.set(l.guardId, { al: l.leaveBalanceWriteback.alTakenCumulative, sl: l.leaveBalanceWriteback.slTakenCumulative, acc: l.leaveBalanceWriteback.slAccruedAtMonthEnd });
      }
    }
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
      let restored = 0;
      let deleted = 0;
      let legacy = 0;
      const done = new Set<string>();
      for (const s of snaps) {
        done.add(key(s.guardId, s.year));
        if (!s.existed) {
          deleted += (await tx.guardLeaveBalance.deleteMany({ where: { guardId: s.guardId, year: s.year } })).count;
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
        const alEnd = n(r.alTakenOpening);
        const slEnd = n(r.slTakenOpening);
        const samePrev = prevMonth && prevMonth.getUTCFullYear() === r.year ? prevMonth : null;
        const d = delta.get(r.guardId) ?? { al: 0, sl: 0, acc: n(r.slAccrued) };
        const data = samePrev
          ? { alTaken: alEnd, slTaken: slEnd, slAccrued: d.acc, asOfMonth: samePrev, alTakenOpening: Math.max(0, round2(alEnd - d.al)), slTakenOpening: Math.max(0, round2(slEnd - d.sl)) }
          : { alTaken: alEnd, slTaken: slEnd, asOfMonth: null, alTakenOpening: alEnd, slTakenOpening: slEnd };
        await tx.guardLeaveBalance.update({ where: { id: r.id }, data });
        restored += 1;
        legacy += 1;
      }
      await tx.guardLeaveBalanceHistory.deleteMany({ where: { month } });

      const cleared = (await tx.guardAvgWage.deleteMany({ where: { month, OR: [{ source: { startsWith: "computed" } }, { source: { contains: "自動計" } }] } })).count;

      await writeAuditTx(tx, {
        actorUserId,
        tableName: "longterm_payroll_runs",
        rowId: runs[0]!.id,
        action: "void_longterm_payroll_month",
        before: { month: monthLabel(month), runs: runs.length },
        after: { reason: why.slice(0, 500), balances_restored: restored, balances_deleted: deleted, legacy_rebuilt: legacy, avg_wages_cleared: cleared },
        ip,
      });
      return { month: monthLabel(month), voided_runs: runs.length, balances_restored: restored, balances_deleted: deleted, legacy_rebuilt: legacy, avg_wages_cleared: cleared, restored_as_of_month: prevMonth ? monthLabel(prevMonth) : null };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
