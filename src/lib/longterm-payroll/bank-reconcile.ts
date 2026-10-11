// P14.3：銀行 BOCHK Payroll Editor 對數——解析（SheetJS，server-only）＋逐人配對／比較（純函數）＋寫入。
// 銀行檔實況（真檔核過，唔含內容）：sheet「Payroll Editor」，表頭喺第 11 行；備考號全空、賬戶名稱係英文大寫（有空格）。
// 配對主鍵：① 備考號 `LT<YYYYMM>-<工號>` ② 戶口（guards.bankAccountNo）③ 英文名 normalize（guards.nameEn → bankPayeeName）。
// 三輪各自跑完先到下一輪（遠距離嘅備考號唔會俾近距離嘅姓名搶走）。容差 ±0.01。
// PII：銀行名只存 sha256（normalize 後）；summary／rows 輸出一律冇銀行名原文、冇戶口。
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequest } from "@/lib/api/errors";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { hashNormalizedName, normalizeEnName } from "./name-norm";
import type { Prisma } from "@prisma/client";

export const RECONCILE_TOLERANCE = 0.01;
export { REASON_CODES, type ReasonCode } from "./reconcile-reasons";
export type ReconStatus = "equal" | "diff" | "bank_only" | "system_only";
export type MatchBy = "remark" | "account" | "name_en" | "none";

export interface BankRow {
  rowNo: number;
  account: string; // 只留數字
  nameNorm: string; // 英文名 normalize（大寫、去非字母數字）
  amount: number | null; // null＝金額壞
  remark: string;
}

export interface ParsedBankFile {
  sheetName: string;
  headerRow: number; // 1-based
  rows: BankRow[];
}

const RE_ACCOUNT = /(賬|帳)戶號碼|a\/c\s*(no\.?|number)?\s*\*?\s*$/i;
const RE_NAME = /(賬|帳)戶名稱|account\s*name|employee\s*name/i;
const RE_AMOUNT = /金額|amount/i;
const RE_REMARK_NO = /備考|reference/i;

function cellText(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = cellText(v).replace(/[, $]/g, "");
  if (!t) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

export const PASSWORD_MSG = "呢個檔案有密碼保護，打唔開——請先用 Excel 另存冇密碼版本，再上載";

/** 解析 Payroll Editor xls／xlsx（Buffer）。表頭行自動搵（頭 60 行內，同時有「員工賬戶名稱」同「金額」）。 */
export function parseBankPayrollEditor(buffer: Buffer): ParsedBankFile {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw BadRequest(PASSWORD_MSG);
    throw BadRequest("讀唔到呢個檔案（唔係有效嘅 Excel 檔）");
  }
  const names = [...wb.SheetNames].sort((a, b) => Number(/payroll\s*editor/i.test(b)) - Number(/payroll\s*editor/i.test(a)));
  for (const sheetName of names) {
    // blankrows:true 保留空行，令陣列 index＋1＝Excel 行號
    const full = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, { header: 1, raw: true, defval: null, blankrows: true });
    let headerIdx = -1;
    let cols = { account: -1, name: -1, amount: -1, remark: -1 };
    for (let i = 0; i < Math.min(full.length, 60); i++) {
      const r = full[i] ?? [];
      const nm = r.findIndex((c) => RE_NAME.test(cellText(c)));
      const am = r.findIndex((c) => RE_AMOUNT.test(cellText(c)));
      if (nm >= 0 && am >= 0) {
        cols = {
          name: nm,
          amount: am,
          account: r.findIndex((c) => RE_ACCOUNT.test(cellText(c))),
          remark: r.findIndex((c) => RE_REMARK_NO.test(cellText(c))),
        };
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) continue;
    const rows: BankRow[] = [];
    for (let i = headerIdx + 1; i < full.length; i++) {
      const r = full[i] ?? [];
      const name = cellText(r[cols.name]);
      const account = cols.account >= 0 ? cellText(r[cols.account]) : "";
      const remark = cols.remark >= 0 ? cellText(r[cols.remark]) : "";
      const amountRaw = r[cols.amount];
      if (!name && !account && !remark) continue; // 空行／合計行（無任何識別）
      rows.push({ rowNo: i + 1, account: account.replace(/\D/g, ""), nameNorm: normalizeEnName(name), amount: parseAmount(amountRaw), remark });
    }
    if (rows.length === 0) throw BadRequest(`分頁「${sheetName}」表頭之後冇讀到任何明細行`);
    return { sheetName, headerRow: headerIdx + 1, rows };
  }
  throw BadRequest("搵唔到 Payroll Editor 表頭行（需要「員工賬戶名稱」同「金額」欄）——請確認係 BOCHK Payroll Editor 檔");
}

export interface SystemLineInfo {
  lineId: string;
  guardId: string;
  autopay: number;
  staffNums: string[]; // normalize 後
  account: string; // 只留數字
  enNames: string[]; // normalize 後（nameEn／bankPayeeName）
}

export interface ReconRowOut {
  guardId: string | null;
  bankRowNo: number;
  bankNameHash: string | null;
  bankAmount: number | null;
  systemLineId: string | null;
  systemAutopay: number | null;
  diff: number | null; // 銀行 − 系統
  matchBy: MatchBy;
  status: ReconStatus;
  note?: string; // 自動註記（重複行／金額壞）
}

export interface ReconSummary {
  bank_rows: number;
  system_lines: number;
  matched: number;
  equal: number;
  diff: { total: number; le1: number; le100: number; gt100: number };
  bank_only: number;
  system_only: number;
  bad_amount_rows: number;
  system_zero_skipped: number;
  match_by: { remark: number; account: number; name_en: number };
  totals: { bank: number; system: number; matched_bank: number; matched_system: number };
  unresolved: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 純函數：配對＋比較。 */
export function compareBankToSystem(bank: BankRow[], system: SystemLineInfo[], monthLabel: string): { rows: ReconRowOut[]; summary: Omit<ReconSummary, "unresolved"> } {
  const yyyymm = monthLabel.replace("-", "");
  const byNum = new Map<string, SystemLineInfo[]>();
  const byAcct = new Map<string, SystemLineInfo[]>();
  const byName = new Map<string, SystemLineInfo[]>();
  const push = (m: Map<string, SystemLineInfo[]>, k: string, l: SystemLineInfo) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    if (!a.includes(l)) a.push(l);
    m.set(k, a);
  };
  for (const l of system) {
    for (const n of l.staffNums) push(byNum, n, l);
    push(byAcct, l.account, l);
    for (const n of l.enNames) push(byName, n, l);
  }
  const used = new Set<string>(); // lineId
  const assign = new Map<number, { line: SystemLineInfo; by: MatchBy }>(); // bank rowNo
  const valid = bank.filter((b) => b.amount !== null);

  // 輪 1：備考號 LT<YYYYMM>-<工號>
  for (const b of valid) {
    const m = /^LT(\d{6})-(.+)$/i.exec(b.remark.trim());
    if (!m || m[1] !== yyyymm) continue;
    const c = (byNum.get(normalizeStaffNumber(m[2]!)) ?? []).filter((l) => !used.has(l.lineId));
    if (c.length === 1) {
      used.add(c[0]!.lineId);
      assign.set(b.rowNo, { line: c[0]!, by: "remark" });
    }
  }
  // 輪 2：戶口
  for (const b of valid) {
    if (assign.has(b.rowNo) || b.account.length < 5) continue;
    const c = (byAcct.get(b.account) ?? []).filter((l) => !used.has(l.lineId));
    if (c.length === 1) {
      used.add(c[0]!.lineId);
      assign.set(b.rowNo, { line: c[0]!, by: "account" });
    }
  }
  // 輪 3：英文名（撞名就用金額縮窄，仍然唔唯一就唔配）
  for (const b of valid) {
    if (assign.has(b.rowNo) || !b.nameNorm) continue;
    let c = (byName.get(b.nameNorm) ?? []).filter((l) => !used.has(l.lineId));
    if (c.length > 1) c = c.filter((l) => Math.abs(l.autopay - b.amount!) <= RECONCILE_TOLERANCE);
    if (c.length === 1) {
      used.add(c[0]!.lineId);
      assign.set(b.rowNo, { line: c[0]!, by: "name_en" });
    }
  }

  const rows: ReconRowOut[] = [];
  const hashOf = (b: BankRow) => (b.nameNorm ? hashNormalizedName(b.nameNorm) : null);
  for (const b of bank) {
    const a = assign.get(b.rowNo);
    if (a) {
      const diff = r2(b.amount! - a.line.autopay);
      rows.push({ guardId: a.line.guardId, bankRowNo: b.rowNo, bankNameHash: hashOf(b), bankAmount: r2(b.amount!), systemLineId: a.line.lineId, systemAutopay: r2(a.line.autopay), diff, matchBy: a.by, status: Math.abs(diff) <= RECONCILE_TOLERANCE ? "equal" : "diff" });
    } else {
      rows.push({
        guardId: null,
        bankRowNo: b.rowNo,
        bankNameHash: hashOf(b),
        bankAmount: b.amount === null ? null : r2(b.amount),
        systemLineId: null,
        systemAutopay: null,
        diff: b.amount === null ? null : r2(b.amount),
        matchBy: "none",
        status: "bank_only",
        note: b.amount === null ? "金額無法解析" : undefined,
      });
    }
  }
  let zeroSkipped = 0;
  for (const l of system) {
    if (used.has(l.lineId)) continue;
    if (Math.abs(l.autopay) <= RECONCILE_TOLERANCE) {
      zeroSkipped += 1; // 系統 autopay 為 0 而銀行冇出糧——一致，唔列為差異
      continue;
    }
    rows.push({ guardId: l.guardId, bankRowNo: 0, bankNameHash: null, bankAmount: null, systemLineId: l.lineId, systemAutopay: r2(l.autopay), diff: r2(-l.autopay), matchBy: "none", status: "system_only" });
  }

  const diffRows = rows.filter((r) => r.status === "diff");
  const abs = (r: ReconRowOut) => Math.abs(r.diff ?? 0);
  const matchedRows = rows.filter((r) => r.status === "equal" || r.status === "diff");
  const summary: Omit<ReconSummary, "unresolved"> = {
    bank_rows: bank.length,
    system_lines: system.length,
    matched: matchedRows.length,
    equal: rows.filter((r) => r.status === "equal").length,
    diff: { total: diffRows.length, le1: diffRows.filter((r) => abs(r) <= 1).length, le100: diffRows.filter((r) => abs(r) > 1 && abs(r) <= 100).length, gt100: diffRows.filter((r) => abs(r) > 100).length },
    bank_only: rows.filter((r) => r.status === "bank_only").length,
    system_only: rows.filter((r) => r.status === "system_only").length,
    bad_amount_rows: bank.filter((b) => b.amount === null).length,
    system_zero_skipped: zeroSkipped,
    match_by: { remark: matchedRows.filter((r) => r.matchBy === "remark").length, account: matchedRows.filter((r) => r.matchBy === "account").length, name_en: matchedRows.filter((r) => r.matchBy === "name_en").length },
    totals: {
      bank: r2(valid.reduce((s, b) => s + b.amount!, 0)),
      system: r2(system.reduce((s, l) => s + l.autopay, 0)),
      matched_bank: r2(matchedRows.reduce((s, r) => s + (r.bankAmount ?? 0), 0)),
      matched_system: r2(matchedRows.reduce((s, r) => s + (r.systemAutopay ?? 0), 0)),
    },
  };
  return { rows, summary };
}

/** 該月有效 run（同 GET /api/longterm/payroll/:month 揀 run 規則一致）。 */
export async function findActiveRun(month: Date) {
  return prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
}

export async function loadSystemLines(runId: string): Promise<SystemLineInfo[]> {
  const lines = await prisma.longtermPayrollLine.findMany({
    where: { runId },
    select: {
      id: true,
      guardId: true,
      autopay: true,
      guard: { select: { staffNo: true, staffNoMw: true, bankAccountNo: true, nameEn: true, bankPayeeName: true, staffNumbers: { select: { number: true } } } },
    },
  });
  return lines.map((l) => ({
    lineId: l.id,
    guardId: l.guardId,
    autopay: Number(l.autopay),
    staffNums: [...new Set([l.guard.staffNo, l.guard.staffNoMw, ...l.guard.staffNumbers.map((x) => x.number)].filter((x): x is string => !!x).map(normalizeStaffNumber))],
    account: (l.guard.bankAccountNo ?? "").replace(/\D/g, ""),
    enNames: [...new Set([normalizeEnName(l.guard.nameEn), normalizeEnName(l.guard.bankPayeeName)].filter(Boolean))],
  }));
}

export function unresolvedCount(rows: Array<{ status: string; reasonCode: string | null }>): number {
  return rows.filter((r) => r.status !== "equal" && !r.reasonCode).length;
}

export interface ReconcileOutcome {
  reconciliationId: string;
  runId: string;
  summary: ReconSummary;
}

export async function runBankReconciliation(params: { month: Date; fileName: string; buffer: Buffer; actorUserId: string }): Promise<ReconcileOutcome> {
  const { month, buffer, actorUserId } = params;
  const run = await findActiveRun(month);
  if (!run) throw BadRequest("呢個月未計過長工糧（冇有效 run），請先「重算本月」再對數");
  const parsed = parseBankPayrollEditor(buffer);
  const system = await loadSystemLines(run.id);
  const { rows, summary: base } = compareBankToSystem(parsed.rows, system, month.toISOString().slice(0, 7));

  // 重新上載：同一個人、差額相同嘅舊「原因」自動帶過嚟（差額變咗就唔帶，要重新判斷）
  const prev = await prisma.longtermBankReconciliation.findFirst({ where: { month }, orderBy: { uploadedAt: "desc" }, select: { id: true } });
  const carry = new Map<string, { diff: number | null; reasonCode: string; reasonNote: string | null; resolvedBy: string | null; resolvedAt: Date | null }>();
  if (prev) {
    const old = await prisma.longtermBankReconciliationRow.findMany({ where: { reconciliationId: prev.id, reasonCode: { not: null }, guardId: { not: null } } });
    for (const o of old) carry.set(o.guardId!, { diff: o.diff === null ? null : Number(o.diff), reasonCode: o.reasonCode!, reasonNote: o.reasonNote, resolvedBy: o.resolvedBy, resolvedAt: o.resolvedAt });
  }

  const sha = createHash("sha256").update(buffer).digest("hex");
  const safeName = params.fileName.replace(/[\r\n]/g, " ").slice(0, 200);
  const created = await prisma.$transaction(
    async (tx) => {
      const rec = await tx.longtermBankReconciliation.create({ data: { month, runId: run.id, fileName: safeName, fileSha256: sha, uploadedBy: actorUserId } });
      const data: Prisma.LongtermBankReconciliationRowCreateManyInput[] = rows.map((r) => {
        const c = r.status !== "equal" && r.guardId ? carry.get(r.guardId) : undefined;
        const keep = c && c.diff !== null && r.diff !== null && Math.abs(c.diff - r.diff) <= RECONCILE_TOLERANCE;
        return {
          reconciliationId: rec.id,
          guardId: r.guardId,
          bankRowNo: r.bankRowNo,
          bankNameNormHash: r.bankNameHash,
          bankAmount: r.bankAmount,
          systemLineId: r.systemLineId,
          systemAutopay: r.systemAutopay,
          diff: r.diff,
          matchBy: r.matchBy,
          status: r.status,
          reasonCode: keep ? c!.reasonCode : null,
          reasonNote: keep ? c!.reasonNote : (r.note ?? null),
          resolvedBy: keep ? c!.resolvedBy : null,
          resolvedAt: keep ? c!.resolvedAt : null,
        };
      });
      for (let i = 0; i < data.length; i += 500) await tx.longtermBankReconciliationRow.createMany({ data: data.slice(i, i + 500) });
      const withReason = data.map((d) => ({ status: d.status, reasonCode: d.reasonCode ?? null }));
      const summary: ReconSummary = { ...base, unresolved: unresolvedCount(withReason) };
      await tx.longtermBankReconciliation.update({ where: { id: rec.id }, data: { summaryJson: summary as unknown as Prisma.InputJsonValue } });
      return { id: rec.id, summary };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return { reconciliationId: created.id, runId: run.id, summary: created.summary };
}
