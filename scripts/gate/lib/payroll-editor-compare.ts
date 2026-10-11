// P11.2：「系統 vs BOCHK Payroll Editor」逐人核對——純函數庫（dev-only，唔入正式站 bundle）。
// 讀 Payroll Editor 舊格式 `.xls`（ExcelJS 讀唔到 → 用 SheetJS `xlsx` 純 JS，devDependency），
// 攞 員工賬戶／姓名／金額（＋備考號 `LT<YYYYMM>-<工號>`），同系統該月最新有效
// `longterm_payroll_runs` 嘅逐人 `autopay` 比對。
//
// PDPO：輸出（console／--out json）一律唔含人名、戶口；配對鍵只用工號（由備考號或系統工號），
// 配唔到嘅 Payroll Editor 行只列行號。
import * as XLSX from "xlsx";
import type { PrismaClient } from "@prisma/client";

export interface PayrollEditorRow {
  /** Excel 行號（1-based），方便規劃者回查原檔 */
  rowNo: number;
  /** 正規化戶口（只留數字）；唔出現喺任何輸出 */
  account: string;
  name: string;
  amount: number;
  /** 由備考號 `LT<YYYYMM>-<工號>` 拆出嘅工號 */
  staffNo: string | null;
}

export interface ParsedPayrollEditor {
  sheetName: string;
  rows: PayrollEditorRow[];
  /** 無法解析金額嘅行（行號） */
  badAmountRows: number[];
}

const RE_ACCOUNT = /(賬|帳)戶號碼|employee\s*a\/c\s*(no\.?|number)?\s*$/i;
const RE_NAME = /(賬|帳)戶名稱|employee\s*name/i;
const RE_AMOUNT = /金額|amount/i;
const RE_REF = /備考|reference/i;

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

export function staffNoFromReference(ref: string): string | null {
  const m = /^LT\d{6}-(.+)$/.exec(ref.trim());
  return m ? m[1] : null;
}

/** 解析 Payroll Editor xls／xlsx。冇表頭 → 退而用 BOCHK 明細固定欄位次序（4 賬戶／5 名稱／6 金額／7 備考號）。 */
export function parsePayrollEditorXls(buffer: Buffer, sheetHint?: string): ParsedPayrollEditor {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = sheetHint && wb.SheetNames.includes(sheetHint) ? sheetHint : (wb.SheetNames.find((n) => /payroll\s*editor|明細/i.test(n)) ?? wb.SheetNames[0]);
  if (!sheetName) throw new Error("xls 冇任何分頁");
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false });

  // 搵表頭行（頭 40 行內，同時有賬戶號碼＋金額欄）
  let headerIdx = -1;
  let cols = { account: 3, name: 4, amount: 5, ref: 6 }; // 0-based 預設＝BOCHK 明細次序
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const r = grid[i] ?? [];
    const a = r.findIndex((c) => RE_ACCOUNT.test(cellText(c)));
    const m = r.findIndex((c) => RE_AMOUNT.test(cellText(c)));
    if (a >= 0 && m >= 0) {
      const nm = r.findIndex((c) => RE_NAME.test(cellText(c)));
      const rf = r.findIndex((c) => RE_REF.test(cellText(c)));
      cols = { account: a, name: nm >= 0 ? nm : a + 1, amount: m, ref: rf };
      headerIdx = i;
      break;
    }
  }

  const rows: PayrollEditorRow[] = [];
  const badAmountRows: number[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const accountRaw = cellText(r[cols.account]);
    const amountRaw = r[cols.amount];
    if (!accountRaw && (amountRaw == null || cellText(amountRaw) === "")) continue; // 空行
    if (headerIdx < 0 && !/\d/.test(accountRaw)) continue; // 無表頭時跳過標題／說明行
    const amount = parseAmount(amountRaw);
    if (amount == null) {
      badAmountRows.push(i + 1);
      continue;
    }
    rows.push({
      rowNo: i + 1,
      account: accountRaw.replace(/\D/g, ""),
      name: cellText(r[cols.name]),
      amount,
      staffNo: cols.ref >= 0 ? staffNoFromReference(cellText(r[cols.ref])) : null,
    });
  }
  return { sheetName, rows, badAmountRows };
}

export interface SystemLine {
  staffNo: string;
  account: string;
  autopay: number;
}

/** 系統該月最新有效 run 嘅逐人 autopay（同 BOCHK 匯出揀 run 嘅規則一致）。 */
export async function loadSystemLines(prisma: PrismaClient, month: Date): Promise<SystemLine[]> {
  const run = await prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
  if (!run) throw new Error("該月未計過長工糧（冇有效 run）");
  const lines = await prisma.longtermPayrollLine.findMany({
    where: { runId: run.id },
    select: { autopay: true, guard: { select: { id: true, staffNo: true, staffNoMw: true, bankAccountNo: true } } },
  });
  return lines.map((l) => ({
    staffNo: l.guard.staffNo ?? l.guard.staffNoMw ?? l.guard.id.slice(0, 8),
    account: (l.guard.bankAccountNo ?? "").replace(/\D/g, ""),
    autopay: Number(l.autopay),
  }));
}

export interface PersonDiff {
  staffNo: string;
  matchedBy: "reference" | "account";
  payrollEditor: number;
  system: number;
  diff: number;
}

export interface CompareResult {
  summary: {
    payrollEditorRows: number;
    systemLines: number;
    matched: number;
    equal: number;
    differing: number;
    diffBuckets: { within1: number; from1To100: number; over100: number };
    maxAbsDiff: number;
    onlyInPayrollEditor: number;
    onlyInSystem: number;
    duplicatePayrollEditorKeys: number;
    badAmountRows: number;
    totals: { payrollEditor: number; system: number; diff: number };
  };
  /** 逐人明細（工號＋金額；冇人名／戶口） */
  details: {
    differing: PersonDiff[];
    equal: PersonDiff[];
    onlyInPayrollEditor: Array<{ rowNo: number; staffNo: string | null; amount: number }>;
    onlyInSystem: Array<{ staffNo: string; autopay: number }>;
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const EQUAL_TOLERANCE = 0.01;

export function comparePayrollEditor(parsed: ParsedPayrollEditor, system: SystemLine[]): CompareResult {
  const sysByStaff = new Map(system.map((s) => [s.staffNo, s]));
  const sysByAccount = new Map<string, SystemLine[]>();
  for (const s of system) if (s.account) sysByAccount.set(s.account, [...(sysByAccount.get(s.account) ?? []), s]);

  const used = new Set<string>();
  const equal: PersonDiff[] = [];
  const differing: PersonDiff[] = [];
  const onlyPe: CompareResult["details"]["onlyInPayrollEditor"] = [];
  let dup = 0;

  for (const p of parsed.rows) {
    let sys: SystemLine | undefined;
    let by: PersonDiff["matchedBy"] = "reference";
    if (p.staffNo && sysByStaff.has(p.staffNo)) sys = sysByStaff.get(p.staffNo);
    else if (p.account) {
      const c = sysByAccount.get(p.account);
      if (c && c.length === 1) {
        sys = c[0];
        by = "account";
      }
    }
    if (!sys) {
      onlyPe.push({ rowNo: p.rowNo, staffNo: p.staffNo, amount: p.amount });
      continue;
    }
    if (used.has(sys.staffNo)) {
      dup += 1;
      onlyPe.push({ rowNo: p.rowNo, staffNo: p.staffNo, amount: p.amount });
      continue;
    }
    used.add(sys.staffNo);
    const diff = r2(p.amount - sys.autopay); // Payroll Editor − 系統
    const rec: PersonDiff = { staffNo: sys.staffNo, matchedBy: by, payrollEditor: r2(p.amount), system: r2(sys.autopay), diff };
    (Math.abs(diff) <= EQUAL_TOLERANCE ? equal : differing).push(rec);
  }

  const onlySys = system.filter((s) => !used.has(s.staffNo)).map((s) => ({ staffNo: s.staffNo, autopay: r2(s.autopay) }));
  const abs = (d: PersonDiff) => Math.abs(d.diff);
  const peTotal = r2(parsed.rows.reduce((a, p) => a + p.amount, 0));
  const sysTotal = r2(system.reduce((a, s) => a + s.autopay, 0));
  return {
    summary: {
      payrollEditorRows: parsed.rows.length,
      systemLines: system.length,
      matched: equal.length + differing.length,
      equal: equal.length,
      differing: differing.length,
      diffBuckets: {
        within1: differing.filter((d) => abs(d) <= 1).length,
        from1To100: differing.filter((d) => abs(d) > 1 && abs(d) <= 100).length,
        over100: differing.filter((d) => abs(d) > 100).length,
      },
      maxAbsDiff: differing.reduce((m, d) => Math.max(m, abs(d)), 0),
      onlyInPayrollEditor: onlyPe.length,
      onlyInSystem: onlySys.length,
      duplicatePayrollEditorKeys: dup,
      badAmountRows: parsed.badAmountRows.length,
      totals: { payrollEditor: peTotal, system: sysTotal, diff: r2(peTotal - sysTotal) },
    },
    details: { differing, equal, onlyInPayrollEditor: onlyPe, onlyInSystem: onlySys },
  };
}
