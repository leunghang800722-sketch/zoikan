// EMP-P2：逐人糧單。一人一份，橫跨唔同雞頭／出糧方；每張工號卡獨立一行（U→MP→MG 次序），
// 同一人同月有 MP 更同 U 更 → 兩行分開列明（唔准撈埋一個總數），最後先加總額。
//   - 每行 key＝guardId＋工號卡 id（見 payroll-by-card.ts），冇歸屬嘅更次歸「未標工號」一行（排最後）。
//   - 出糧方／出糧方式讀 `staff_schemes`（唔寫死）。
//   - 長工體系（staff_schemes.is_longterm，出廠 MG）行：P3 前金額由長工糧表現有 line 取（`longterm_payroll_lines`
//     按 guardId＋月，取該月未作廢嘅最新 run；攞唔到就 0），標 note「見長工糧表」；唔用該卡更次 snapshot 加總（避免重複計）。
// 只讀報表，唔掂計糧邏輯。
import { prisma } from "@/lib/db";
import { n, round2, monthRange } from "./money";
import { memoized } from "./context";
import { buildPayrollByCard, NO_CARD_LABEL } from "./payroll-by-card";
import { loadStaffSchemes, schemeInfoOf, type StaffSchemeInfo } from "@/lib/guards/staff-schemes";

export const LONGTERM_NOTE = "見長工糧表";

interface PayslipLine {
  staffNumberId: string | null;
  /** null＝未標工號 */
  scheme: string | null;
  schemeLabel: string;
  number: string | null;
  payerCode: string | null;
  payerLabel: string | null;
  payMethod: string | null;
  /** 呢張卡嘅更次涉及嘅結算單位代號（未歸屬＝「未歸屬」） */
  settlementBrokerCodes: string[];
  settlementBrokerCode: string;
  shifts: number;
  wage: number;
  fee: number;
  amount: number;
  note?: string;
}

export interface Payslip {
  guardId: string;
  guardName: string;
  /** guards.staff_no（舊顯示欄；未標工號行用） */
  staffNo: string | null;
  lines: PayslipLine[];
  total: number;
}

export function buildPayslips(month: Date): Promise<Payslip[]> {
  return memoized(`payslips:${monthRange(month).start.toISOString()}`, () => buildPayslipsUncached(month));
}

async function buildPayslipsUncached(month: Date): Promise<Payslip[]> {
  const rows = await buildPayrollByCard(month);
  const schemes = await loadStaffSchemes();
  const longtermCodes = [...schemes.values()].filter((s) => s.isLongterm).map((s) => s.code);
  const monthFirst = monthRange(month).start;

  // 長工糧 line：該月未作廢嘅最新 run（confirmed 優先，其次最新 draft）
  const runs = await prisma.longtermPayrollRun.findMany({ where: { month: monthFirst, voidedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
  const run = runs.find((r) => r.status === "confirmed") ?? runs[0] ?? null;
  const ltLines = run ? await prisma.longtermPayrollLine.findMany({ where: { runId: run.id }, select: { guardId: true, gross: true, autopay: true } }) : [];
  const ltByGuard = new Map(ltLines.map((l) => [l.guardId, l]));

  const guardIds = [...new Set([...rows.map((r) => r.guardId), ...ltByGuard.keys()])];
  const brokerIds = [...new Set(rows.map((r) => r.settlementBrokerId).filter((v): v is string => !!v))];
  const [guards, brokers, ltCards] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, nameZh: true, staffNo: true, staffNoMw: true } }),
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, code: true } }) : Promise.resolve([]),
    longtermCodes.length ? prisma.guardStaffNumber.findMany({ where: { guardId: { in: [...ltByGuard.keys()] }, scheme: { in: longtermCodes } }, select: { id: true, guardId: true, scheme: true, number: true, status: true } }) : Promise.resolve([]),
  ]);
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const brokerCode = new Map(brokers.map((b) => [b.id, b.code]));

  // 先按 (guard, card) 合併（跨雞頭），仍然保持卡獨立
  type Acc = { guardId: string; staffNumberId: string | null; scheme: string | null; number: string | null; shifts: number; wage: number; fee: number; brokers: Set<string> };
  const accByKey = new Map<string, Acc>();
  for (const r of rows) {
    const a = accByKey.get(r.key) ?? { guardId: r.guardId, staffNumberId: r.staffNumberId, scheme: r.scheme, number: r.number, shifts: 0, wage: 0, fee: 0, brokers: new Set<string>() };
    a.shifts += r.shifts;
    a.wage = round2(a.wage + r.wage);
    a.fee = round2(a.fee + r.fee);
    a.brokers.add(r.settlementBrokerId ? (brokerCode.get(r.settlementBrokerId) ?? "?") : "未歸屬");
    accByKey.set(r.key, a);
  }

  const byGuard = new Map<string, PayslipLine[]>();
  const push = (guardId: string, line: PayslipLine) => (byGuard.get(guardId) ?? byGuard.set(guardId, []).get(guardId)!).push(line);
  const lineOf = (info: StaffSchemeInfo | null, a: Acc, longtermAmount: number | null, note?: string): PayslipLine => {
    const codes = [...a.brokers].sort();
    const wage = longtermAmount === null ? a.wage : 0;
    const fee = longtermAmount === null ? a.fee : 0;
    return {
      staffNumberId: a.staffNumberId,
      scheme: a.scheme,
      schemeLabel: info ? info.labelZh : NO_CARD_LABEL,
      number: a.number,
      payerCode: info?.payerCode ?? null,
      payerLabel: info?.payerLabelZh ?? null,
      payMethod: info?.payMethod ?? null,
      settlementBrokerCodes: codes,
      settlementBrokerCode: codes.join("/"),
      shifts: a.shifts,
      wage,
      fee,
      amount: longtermAmount === null ? round2(wage + fee) : round2(longtermAmount),
      ...(note ? { note } : {}),
    };
  };

  const ltDone = new Set<string>();
  for (const a of accByKey.values()) {
    const info = schemeInfoOf(schemes, a.scheme);
    if (info?.isLongterm) {
      const lt = ltByGuard.get(a.guardId);
      push(a.guardId, lineOf(info, a, lt ? n(lt.gross) : 0, lt ? LONGTERM_NOTE : `${LONGTERM_NOTE}（未有該月長工糧資料）`));
      ltDone.add(a.guardId);
    } else {
      push(a.guardId, lineOf(info, a, null));
    }
  }
  // 有長工糧 line 但未有長工體系嘅更次 → 補一行長工行（冇更次，shifts=0）
  const ltScheme = longtermCodes[0] ? schemeInfoOf(schemes, longtermCodes[0]) : null;
  if (ltScheme) {
    for (const [guardId, lt] of ltByGuard) {
      if (ltDone.has(guardId)) continue;
      const card = ltCards.filter((c) => c.guardId === guardId && c.scheme === ltScheme.code).sort((x, y) => (x.status === y.status ? 0 : x.status === "current" ? -1 : 1))[0];
      const g = guardById.get(guardId);
      push(guardId, lineOf(ltScheme, { guardId, staffNumberId: card?.id ?? null, scheme: ltScheme.code, number: card?.number ?? g?.staffNoMw ?? null, shifts: 0, wage: 0, fee: 0, brokers: new Set() }, n(lt.gross), LONGTERM_NOTE));
    }
  }

  const sortKey = (l: PayslipLine) => (l.scheme === null ? 9999 : (schemeInfoOf(schemes, l.scheme)?.sort ?? 999));
  const out: Payslip[] = [];
  for (const [guardId, lines] of byGuard) {
    const g = guardById.get(guardId);
    lines.sort((x, y) => sortKey(x) - sortKey(y) || (x.number ?? "").localeCompare(y.number ?? ""));
    out.push({ guardId, guardName: g?.nameZh ?? "", staffNo: g?.staffNo ?? null, lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) });
  }
  out.sort((a, b) => a.guardName.localeCompare(b.guardName, "zh-Hant") || a.guardId.localeCompare(b.guardId));
  return out;
}

