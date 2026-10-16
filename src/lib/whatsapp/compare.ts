// W1：dry-run 對照——將 intent 嘅建議同「實際排更」（同人同日嘅 shift_records）對一對（server-only）。
//   match（✓）＝實際排更同建議一致；mismatch（✗）＝有排更但唔一致；none（—）＝實際排更未有；null＝呢類 intent 唔做對照。
import { prisma } from "@/lib/db";
import { isoToDbDate } from "./dates";

type CompareStatus = "match" | "mismatch" | "none";

export interface CompareIntent {
  id: string;
  kind: string;
  guardId: string | null;
  workDate: string | null;
  shiftTypeId: string | null;
  leaveCode: string | null;
}

export interface CompareResult {
  status: CompareStatus | null;
  /** 實際排更摘要：例 ["shift:N","leave:SL"]（更碼／請假碼，非 PII） */
  actual: string[];
}

function normLeave(c: string | null): string | null {
  return c === "OFF" ? "RD" : c === "NPL" ? "NL" : c;
}

/** 純函數：intent vs 當日實際記錄。 */
export function compareOne(intent: CompareIntent, records: Array<{ recordType: string; shiftTypeId: string; leaveCode: string | null; code?: string }>): CompareResult {
  if ((intent.kind !== "shift" && intent.kind !== "leave") || !intent.guardId || !intent.workDate) return { status: null, actual: [] };
  const real = records.filter((r) => r.recordType !== "ot");
  const actual = real.map((r) => (r.recordType === "leave" ? `leave:${r.leaveCode ?? "?"}` : `shift:${r.code ?? "?"}`));
  if (real.length === 0) return { status: "none", actual };
  if (intent.kind === "shift") {
    if (!intent.shiftTypeId) return { status: null, actual };
    return { status: real.some((r) => r.recordType === "shift" && r.shiftTypeId === intent.shiftTypeId) ? "match" : "mismatch", actual };
  }
  const lv = normLeave(intent.leaveCode);
  if (!lv) return { status: null, actual };
  return { status: real.some((r) => r.recordType === "leave" && normLeave(r.leaveCode) === lv) ? "match" : "mismatch", actual };
}

/** 批量對照（一次查晒相關 guard×日子）。 */
export async function compareIntents(intents: CompareIntent[]): Promise<Map<string, CompareResult>> {
  const out = new Map<string, CompareResult>();
  const eligible = intents.filter((i) => (i.kind === "shift" || i.kind === "leave") && i.guardId && i.workDate);
  const guardIds = [...new Set(eligible.map((i) => i.guardId!))];
  const dates = [...new Set(eligible.map((i) => i.workDate!))].map(isoToDbDate);
  const recs = eligible.length
    ? await prisma.shiftRecord.findMany({
        where: { guardId: { in: guardIds }, workDate: { in: dates }, status: { not: "cancelled" } },
        select: { guardId: true, workDate: true, recordType: true, shiftTypeId: true, leaveCode: true, shiftType: { select: { code: true } } },
      })
    : [];
  const byKey = new Map<string, Array<{ recordType: string; shiftTypeId: string; leaveCode: string | null; code?: string }>>();
  for (const r of recs) {
    const k = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`;
    const arr = byKey.get(k) ?? [];
    arr.push({ recordType: r.recordType, shiftTypeId: r.shiftTypeId, leaveCode: r.leaveCode, code: r.shiftType.code });
    byKey.set(k, arr);
  }
  for (const i of intents) {
    out.set(i.id, compareOne(i, i.guardId && i.workDate ? (byKey.get(`${i.guardId}|${i.workDate}`) ?? []) : []));
  }
  return out;
}
