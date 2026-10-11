// P10.2：反推入口（DB 讀取＋純函數 `inferCoverRates`）。唔寫任何嘢。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { n } from "@/lib/reports/money";
import { loadCoverShifts } from "./cover-shifts";
import { inferCoverRates, isCoverNote, type InferResult, type TaggedInput } from "./cover-infer";

export function parseMonthsList(raw: string | null): Date[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return null;
  const out: Date[] = [];
  for (const p of parts) {
    const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(p);
    if (!m) return null;
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    out.push(new Date(Date.UTC(Number(m[1]), mo - 1, 1)));
  }
  return [...new Map(out.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
}

export async function runCoverInference(months: Date[]): Promise<InferResult> {
  const load = await loadCoverShifts(months);
  const monthLabels = months.map((m) => monthRange(m).start.toISOString().slice(0, 7));
  const inputsRaw = await prisma.longtermPayrollInput.findMany({
    where: { month: { in: months }, kind: "other_allowance", status: "confirmed", voidedAt: null },
    select: { id: true, guardId: true, month: true, amount: true, note: true },
  });
  const tagged: TaggedInput[] = [];
  const untaggedGm = new Set<string>();
  const shiftGm = new Set(load.shifts.map((s) => `${s.guardId}|${s.month}`));
  for (const i of inputsRaw) {
    const month = i.month.toISOString().slice(0, 7);
    if (i.amount === null) continue;
    if (isCoverNote(i.note)) tagged.push({ id: i.id, guardId: i.guardId, month, amount: n(i.amount), note: i.note });
    else if (shiftGm.has(`${i.guardId}|${month}`)) untaggedGm.add(`${i.guardId}|${month}`);
  }
  // 輸入有但該長工當月冇頂位更嘅盤名：siteNames 仍要供 note 配對，用頂過嘅盤名
  const siteNames = new Map([...load.sites.entries()].map(([id, s]) => [id, s.name]));
  return inferCoverRates({ months: monthLabels, shifts: load.shifts, inputs: tagged, siteNames, untaggedOtherAllowanceGuardMonths: untaggedGm.size });
}
