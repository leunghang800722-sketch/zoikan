// P19b：EO 平均工資（adw.ts）所需嘅歷史月份工資——由已計好嘅 longterm_payroll_lines（每月取最新未作廢 run）砌，純讀。
// 工資＝net_basic＋OT＋賣假＋津貼＋法定假扣款＋無薪／病假扣款（即已扣走不獲全薪日子工資）＋加返人手扣款（人手扣款唔係不獲全薪日子）；
// 唔計年假補償、4/5 病假津貼。不獲全薪日子＝NPL 日數＋病假日（更表 SL 日同 npsl_days 取大）＋無薪法定假日（近似：npsh 扣款 ÷ 合約日薪，上限更表 SH 日數）。
import type { PrismaClient, Prisma } from "@prisma/client";
import { n, round2 } from "@/lib/reports/money";
import { daysInMonth } from "./compute";
import type { AdwMonthData } from "./adw";

type PrismaLike = PrismaClient | Prisma.TransactionClient;

const monthKey = (d: Date): string => d.toISOString().slice(0, 7);

/** months＝要查嘅月份首日（都應 < 正在計算嗰個月）。只回傳有糧線嘅月份。 */
export async function loadAdwMonthData(client: PrismaLike, guardId: string, months: Date[]): Promise<Record<string, AdwMonthData>> {
  const out: Record<string, AdwMonthData> = {};
  if (!months.length) return out;
  const runs = await client.longtermPayrollRun.findMany({
    where: { month: { in: months }, voidedAt: null, status: { not: "void" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, month: true },
  });
  const latestRunByMonth = new Map<string, string>();
  for (const r of runs) if (!latestRunByMonth.has(monthKey(r.month))) latestRunByMonth.set(monthKey(r.month), r.id);
  const runIds = [...latestRunByMonth.values()];
  if (!runIds.length) return out;
  const lines = await client.longtermPayrollLine.findMany({ where: { runId: { in: runIds }, guardId } });
  const lineByRun = new Map(lines.map((l) => [l.runId, l]));

  const first = months.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  const last = months.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  const lastEnd = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0));
  const [manualDeductions, leaveRows] = await Promise.all([
    client.longtermPayrollInput.findMany({ where: { guardId, month: { in: months }, kind: "deduction", voidedAt: null, status: "confirmed" }, select: { month: true, amount: true } }),
    client.shiftRecord.findMany({
      where: { guardId, workDate: { gte: first, lte: lastEnd }, recordType: "leave", leaveCode: { in: ["SL", "SH"] }, status: { not: "cancelled" } },
      select: { workDate: true, leaveCode: true },
    }),
  ]);
  const manualByMonth = new Map<string, number>();
  for (const d of manualDeductions) manualByMonth.set(monthKey(d.month), (manualByMonth.get(monthKey(d.month)) ?? 0) + Math.abs(n(d.amount)));
  const slDates = new Map<string, Set<string>>();
  const shDates = new Map<string, Set<string>>();
  for (const r of leaveRows) {
    const target = r.leaveCode === "SL" ? slDates : shDates;
    const k = monthKey(r.workDate);
    const set = target.get(k) ?? new Set<string>();
    set.add(r.workDate.toISOString().slice(0, 10));
    target.set(k, set);
  }

  for (const ms of months) {
    const key = monthKey(ms);
    const runId = latestRunByMonth.get(key);
    const line = runId ? lineByRun.get(runId) : undefined;
    if (!line) continue;
    const dim = daysInMonth(ms.getUTCFullYear(), ms.getUTCMonth() + 1);
    const wages = round2(n(line.netBasic) + n(line.otAmount) + n(line.restDayPayment) + n(line.specialAllowance) + n(line.otherAllowance) + n(line.npsh) + n(line.deduction) + (manualByMonth.get(key) ?? 0));
    const snapshot = Array.isArray(line.contractSnapshot) ? (line.contractSnapshot as Array<{ monthlySalary?: number }>) : [];
    const monthly = Number(snapshot[snapshot.length - 1]?.monthlySalary ?? 0);
    const sickDays = Math.max(slDates.get(key)?.size ?? 0, Math.round(n(line.npslDays)));
    const shCount = shDates.get(key)?.size ?? 0;
    const shUnpaid = n(line.npsh) < 0 && monthly > 0 ? Math.min(shCount, Math.max(1, Math.round(-n(line.npsh) / (monthly / dim)))) : 0;
    out[key] = { wages, disregardedDays: Math.round(n(line.nplDays)) + sickDays + shUnpaid };
  }
  return out;
}
