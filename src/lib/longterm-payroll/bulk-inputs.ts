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

const BULK_SOURCE = "bulk_import";
const BULK_MAX_ROWS = 500;

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
  /** 撞到同人同段嘅 draft → 直接確認（唔新增重複行）嘅數量。 */
  confirmed_existing_draft: number;
  unmatched: Array<{ row: number; reason: "no_identifier" | "no_match" | "ambiguous"; staff_no?: string }>;
  overlaps: Array<{ row: number; reason: string }>;
  invalid: Array<{ row: number; reason: string }>;
  /** P16b.1：同人／種類／日期／金額一樣但 note 唔同 → 當不同項目分開新增（預覽列明）。 */
  separate_by_note: Array<{ row: number; reason: string }>;
};

const MONEY_KINDS = new Set<string>(["special_allowance", "other_allowance", "uniform", "deduction"]);

export interface GuardIdx {
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

export type Match = { guardId: string } | { reason: "no_identifier" | "no_match" | "ambiguous" };

export function matchBulkRow(row: Pick<BulkInputRow, "staff_no" | "staff_no_mw" | "name_en" | "name_zh">, idx: GuardIdx): Match {
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

/** date_from ≤ date_to，而且兩個日期都喺該月內（跨月段唔收，要拆做每月一段）。 */
export function checkDates(month: Date, from: string | null | undefined, to: string | null | undefined): string | null {
  const ym = month.toISOString().slice(0, 7);
  if (from && to && from > to) return "date_from 遲過 date_to";
  if (from && from.slice(0, 7) !== ym) return "date_from 唔喺該月內";
  if (to && to.slice(0, 7) !== ym) return "date_to 唔喺該月內（跨月請拆做每月一段）";
  return null;
}

function amountKey(a: unknown): string {
  if (a === null || a === undefined || a === "") return "null";
  return Number(a).toFixed(2);
}

/** note 比較用：去「[批量導入]」前綴、空白 normalize。 */
function noteKey(n: string | null | undefined): string {
  return (n ?? "").replace(/^\s*\[批量導入\]\s*/, "").replace(/\s+/g, " ").trim();
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
  const result: BulkInputResult = { dry_run: dryRun, total: rows.length, matched: 0, created: 0, skipped_duplicate: 0, confirmed_existing_draft: 0, unmatched: [], overlaps: [], invalid: [], separate_by_note: [] };

  const work = async (db: Prisma.TransactionClient | null) => {
    const client = db ?? prisma;
    const existing = await client.longtermPayrollInput.findMany({ where: { month, voidedAt: null }, select: { id: true, guardId: true, kind: true, dateFrom: true, dateTo: true, amount: true, status: true, note: true, draftSource: true } });
    // 重複只比 confirmed；draft 唔計（aggregate 只計 confirmed）——撞到同人同段嘅 draft 就直接確認佢
    const draftByKey = new Map<string, (typeof existing)[number]>();
    for (const e of existing) if (e.status === "draft") draftByKey.set(dupKey(e.guardId, e.kind, e.dateFrom, e.dateTo, e.amount === null ? null : Number(e.amount)), e);
    // P16b.1：confirmed 重複 key 加 note（同金額唔同 note ＝ 不同項目，例如 OT 650 同補假日工資 650）
    const baseOf = (e: (typeof existing)[number]) => dupKey(e.guardId, e.kind, e.dateFrom, e.dateTo, e.amount === null ? null : Number(e.amount));
    const seen = new Set(existing.filter((e) => e.status === "confirmed").map((e) => `${baseOf(e)}|${noteKey(e.note)}`));
    // 系統草稿（draftSource cover:*／roster_leave:* 等，非 bulk_import）確認嘅行，note 係系統原文（可能加「批量導入確認」），唔代表人手 note → 同 base 一律當重複（保持原冪等）
    const confirmedFromDraft = new Set(existing.filter((e) => e.status === "confirmed" && ((e.draftSource !== null && e.draftSource !== BULK_SOURCE) || (e.note ?? "").endsWith("批量導入確認"))).map(baseOf));
    const seenBase = new Set(existing.filter((e) => e.status === "confirmed").map(baseOf));
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
      const dateErr = checkDates(month, from, to);
      if (dateErr) {
        result.invalid.push({ row: n, reason: dateErr });
        continue;
      }
      const key = dupKey(m.guardId, row.kind, from, to, amount);
      const fullKey = `${key}|${noteKey(row.note)}`;
      if (seen.has(fullKey) || confirmedFromDraft.has(key)) {
        result.skipped_duplicate += 1;
        continue;
      }
      const draft = draftByKey.get(key);
      if (row.kind === "leave") {
        const b = to ?? from!;
        const dbHit = await findConfirmedLeaveOverlap(m.guardId, month, from, to, draft?.id, client);
        const memHit = pendingLeave.some((p) => p.guardId === m.guardId && p.from <= b && p.to >= from!);
        if (dbHit || memHit) {
          result.overlaps.push({ row: n, reason: OVERLAP_MSG });
          continue;
        }
        pendingLeave.push({ guardId: m.guardId, from: from!, to: b });
      }
      if (draft) {
        // 同人同段嘅草稿未確認就唔入糧——直接確認佢，唔新增重複行
        draftByKey.delete(key);
        seen.add(fullKey);
        seenBase.add(key);
        confirmedFromDraft.add(key);
        result.confirmed_existing_draft += 1;
        if (!dryRun && db) {
          const after = await db.longtermPayrollInput.update({
            where: { id: draft.id },
            data: { status: "confirmed", confirmedAt: new Date(), confirmedBy: actorUserId, note: `${draft.note ?? ""}${draft.note ? "；" : ""}批量導入確認`, ...(row.doctor_note_verified !== undefined ? { doctorNoteVerified: row.doctor_note_verified } : {}) },
          });
          await writeAuditTx(db, { actorUserId, tableName: "longterm_payroll_inputs", rowId: draft.id, action: "confirm", before: { status: "draft" }, after: { status: after.status, source: BULK_SOURCE }, ip });
        }
        continue;
      }
      if (seenBase.has(key)) result.separate_by_note.push({ row: n, reason: "同金額但 note 唔同 → 會分開新增（唔當重複）" });
      seen.add(fullKey);
      seenBase.add(key);
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
