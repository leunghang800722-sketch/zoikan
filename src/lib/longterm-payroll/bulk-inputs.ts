// P14.2：長工糧人手輸入批量導入（≤500 行）。逐行配 guard（staff_no → staff_no_mw → name_en normalize → name_zh），
// 配唔到列入 unmatched；冪等（同 month／guard／kind／date_from／date_to／amount 已存在未作廢 → skipped_duplicate）；
// 病假段重疊已確認段 → 逐行列入 overlaps（唔整批失敗）；寫入 status=confirmed，draftSource=bulk_import。
// 回應同 audit 唔含姓名。月份必須未鎖（tx 內 assertMonthNotLockedTx）。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { assertMonthNotLocked, assertMonthNotLockedTx } from "@/lib/month-lock";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { findConfirmedLeaveOverlap, OVERLAP_MSG } from "./drafts";
import { normalizeEnName } from "./name-norm";
import { BadRequest } from "@/lib/api/errors";
import type { Prisma, LongtermPayrollInputKind } from "@prisma/client";

export const BULK_SOURCE = "bulk_import";
export const BULK_MAX_ROWS = 500;

export interface BulkInputRow {
  staff_no?: string;
  staff_no_mw?: string;
  name_en?: string;
  name_zh?: string;
  kind: LongtermPayrollInputKind;
  amount?: number | string | null;
  date_from?: string | null;
  date_to?: string | null;
  doctor_note_verified?: boolean;
  note?: string;
}

export type BulkInputResult = {
  dry_run: boolean;
  total: number;
  matched: number;
  created: number;
  skipped_duplicate: number;
  unmatched: Array<{ row: number; reason: "no_identifier" | "no_match" | "ambiguous"; staff_no?: string }>;
  overlaps: Array<{ row: number; reason: string }>;
  invalid: Array<{ row: number; reason: string }>;
};

const MONEY_KINDS = new Set<string>(["special_allowance", "other_allowance", "uniform", "deduction"]);

interface GuardIdx {
  byNumber: Map<string, Set<string>>;
  byEn: Map<string, Set<string>>;
  byZh: Map<string, Set<string>>;
}

function add(m: Map<string, Set<string>>, k: string, id: string) {
  if (!k) return;
  const s = m.get(k) ?? new Set<string>();
  s.add(id);
  m.set(k, s);
}

export async function buildGuardIndex(): Promise<GuardIdx> {
  const guards = await prisma.guard.findMany({ select: { id: true, nameZh: true, nameEn: true, staffNo: true, staffNoMw: true, staffNumbers: { select: { number: true } } } });
  const idx: GuardIdx = { byNumber: new Map(), byEn: new Map(), byZh: new Map() };
  for (const g of guards) {
    for (const n of [g.staffNo, g.staffNoMw, ...g.staffNumbers.map((x) => x.number)]) if (n) add(idx.byNumber, normalizeStaffNumber(n), g.id);
    add(idx.byEn, normalizeEnName(g.nameEn), g.id);
    add(idx.byZh, g.nameZh.replace(/\s+/g, ""), g.id);
  }
  return idx;
}

type Match = { guardId: string } | { reason: "no_identifier" | "no_match" | "ambiguous" };

export function matchBulkRow(row: BulkInputRow, idx: GuardIdx): Match {
  const tries: Array<[Map<string, Set<string>>, string]> = [];
  if (row.staff_no?.trim()) tries.push([idx.byNumber, normalizeStaffNumber(row.staff_no)]);
  if (row.staff_no_mw?.trim()) tries.push([idx.byNumber, normalizeStaffNumber(row.staff_no_mw)]);
  if (row.name_en?.trim()) tries.push([idx.byEn, normalizeEnName(row.name_en)]);
  if (row.name_zh?.trim()) tries.push([idx.byZh, row.name_zh.replace(/\s+/g, "")]);
  if (tries.length === 0) return { reason: "no_identifier" };
  let ambiguous = false;
  for (const [m, key] of tries) {
    const hit = key ? m.get(key) : undefined;
    if (!hit) continue;
    if (hit.size === 1) return { guardId: [...hit][0]! };
    ambiguous = true;
  }
  return { reason: ambiguous ? "ambiguous" : "no_match" };
}

function amountKey(a: unknown): string {
  if (a === null || a === undefined || a === "") return "null";
  return Number(a).toFixed(2);
}

function dupKey(guardId: string, kind: string, from: string | null, to: string | null, amount: unknown): string {
  return `${guardId}|${kind}|${from ?? ""}|${to ?? ""}|${amountKey(amount)}`;
}

function normAmount(a: BulkInputRow["amount"]): number | null | "bad" {
  if (a === null || a === undefined || a === "") return null;
  const n = Number(a);
  return Number.isFinite(n) ? n : "bad";
}

export async function bulkImportInputs(params: { month: Date; rows: BulkInputRow[]; actorUserId: string; ip: string | null; dryRun?: boolean }): Promise<BulkInputResult> {
  const { month, rows, actorUserId, ip } = params;
  const dryRun = !!params.dryRun;
  if (rows.length > BULK_MAX_ROWS) throw BadRequest(`一次最多 ${BULK_MAX_ROWS} 行`);
  const idx = await buildGuardIndex();
  const result: BulkInputResult = { dry_run: dryRun, total: rows.length, matched: 0, created: 0, skipped_duplicate: 0, unmatched: [], overlaps: [], invalid: [] };

  const work = async (db: Prisma.TransactionClient | null) => {
    const client = db ?? prisma;
    const existing = await client.longtermPayrollInput.findMany({ where: { month, voidedAt: null }, select: { guardId: true, kind: true, dateFrom: true, dateTo: true, amount: true } });
    const seen = new Set(existing.map((e) => dupKey(e.guardId, e.kind, e.dateFrom, e.dateTo, e.amount === null ? null : Number(e.amount))));
    const pendingLeave: Array<{ guardId: string; from: string; to: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const n = i + 1;
      const m = matchBulkRow(row, idx);
      if (!("guardId" in m)) {
        result.unmatched.push({ row: n, reason: m.reason, ...(row.staff_no ? { staff_no: row.staff_no.trim().slice(0, 20) } : row.staff_no_mw ? { staff_no: row.staff_no_mw.trim().slice(0, 20) } : {}) });
        continue;
      }
      result.matched += 1;
      const amount = normAmount(row.amount);
      if (amount === "bad") {
        result.invalid.push({ row: n, reason: "金額唔係數字" });
        continue;
      }
      if (MONEY_KINDS.has(row.kind) && amount === null) {
        result.invalid.push({ row: n, reason: "呢個種類要帶金額" });
        continue;
      }
      const from = row.date_from ?? null;
      const to = row.date_to ?? null;
      if (row.kind === "leave" && !from) {
        result.invalid.push({ row: n, reason: "kind=leave 要帶 date_from" });
        continue;
      }
      const key = dupKey(m.guardId, row.kind, from, to, amount);
      if (seen.has(key)) {
        result.skipped_duplicate += 1;
        continue;
      }
      if (row.kind === "leave") {
        const b = to ?? from!;
        const dbHit = await findConfirmedLeaveOverlap(m.guardId, month, from, to, undefined, client);
        const memHit = pendingLeave.some((p) => p.guardId === m.guardId && p.from <= b && p.to >= from!);
        if (dbHit || memHit) {
          result.overlaps.push({ row: n, reason: OVERLAP_MSG });
          continue;
        }
        pendingLeave.push({ guardId: m.guardId, from: from!, to: b });
      }
      seen.add(key);
      result.created += 1;
      if (dryRun || !db) continue;
      const created = await db.longtermPayrollInput.create({
        data: {
          month,
          guardId: m.guardId,
          kind: row.kind,
          amount: amount === null ? undefined : amount,
          dateFrom: from,
          dateTo: to,
          doctorNoteVerified: row.doctor_note_verified,
          note: row.note ? `[批量導入] ${row.note}` : "[批量導入]",
          status: "confirmed",
          draftSource: BULK_SOURCE,
          confirmedAt: new Date(),
          confirmedBy: actorUserId,
          createdBy: actorUserId,
        },
      });
      await writeAuditTx(db, { actorUserId, tableName: "longterm_payroll_inputs", rowId: created.id, action: "create", after: { guardId: created.guardId, kind: created.kind, month, source: BULK_SOURCE }, ip });
    }
  };

  if (dryRun) {
    await assertMonthNotLocked({ workDate: month, actorUserId, tableName: "longterm_payroll_inputs", rowId: "bulk", ip });
    await work(null);
  } else {
    await prisma.$transaction(
      async (tx) => {
        await assertMonthNotLockedTx(tx, { workDate: month, actorUserId, tableName: "longterm_payroll_inputs", rowId: "bulk", ip });
        await work(tx);
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
  return result;
}
