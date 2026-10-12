// P15.2：平均工資批量導入（≤500 行）。配對次序同 P14.2 一樣（staff_no → staff_no_mw → name_en → name_zh）；
// source 固定前綴 `manual:`（`manual:批量導入`＋可選備註）；冪等（同 guard／month 同金額已存在 → skipped_unchanged；金額唔同 → 更新 updated）；
// 檔內同人重複：同值略過、異值列 invalid。月份必須未鎖。回應同 audit 唔含姓名。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { assertMonthNotLocked, assertMonthNotLockedTx } from "@/lib/month-lock";
import { BadRequest } from "@/lib/api/errors";
import { buildGuardIndex, matchBulkRow } from "./bulk-inputs";
import type { Prisma } from "@prisma/client";

const MAX_ROWS = 500;

export interface BulkAvgWageRow {
  staff_no?: string;
  staff_no_mw?: string;
  name_en?: string;
  name_zh?: string;
  avg_daily_wage: number | string;
  note?: string;
}

export type BulkAvgWageResult = {
  dry_run: boolean;
  total: number;
  matched: number;
  created: number;
  updated: number;
  skipped_unchanged: number;
  unmatched: Array<{ row: number; reason: "no_identifier" | "no_match" | "ambiguous"; staff_no?: string }>;
  invalid: Array<{ row: number; reason: string }>;
};

export async function bulkImportAvgWages(params: { month: Date; rows: BulkAvgWageRow[]; actorUserId: string; ip: string | null; dryRun?: boolean }): Promise<BulkAvgWageResult> {
  const { month, rows, actorUserId, ip } = params;
  const dryRun = !!params.dryRun;
  if (rows.length > MAX_ROWS) throw BadRequest(`一次最多 ${MAX_ROWS} 行`);
  const idx = await buildGuardIndex();
  const result: BulkAvgWageResult = { dry_run: dryRun, total: rows.length, matched: 0, created: 0, updated: 0, skipped_unchanged: 0, unmatched: [], invalid: [] };

  const work = async (db: Prisma.TransactionClient | null) => {
    const client = db ?? prisma;
    const existing = await client.guardAvgWage.findMany({ where: { month } });
    const byGuard = new Map(existing.map((e) => [e.guardId, e]));
    const seenInFile = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rn = i + 1;
      const m = matchBulkRow(row, idx);
      if (!("guardId" in m)) {
        result.unmatched.push({ row: rn, reason: m.reason, ...(row.staff_no ? { staff_no: row.staff_no.trim().slice(0, 20) } : row.staff_no_mw ? { staff_no: row.staff_no_mw.trim().slice(0, 20) } : {}) });
        continue;
      }
      result.matched += 1;
      const raw = typeof row.avg_daily_wage === "string" ? row.avg_daily_wage.trim() : row.avg_daily_wage;
      const v = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(v) || v <= 0 || v > 100000) {
        result.invalid.push({ row: rn, reason: "avg_daily_wage 要係大過 0 嘅數字" });
        continue;
      }
      const val = Math.round(v * 100) / 100;
      const prevVal = seenInFile.get(m.guardId);
      if (prevVal !== undefined) {
        if (prevVal === val) result.skipped_unchanged += 1;
        else result.invalid.push({ row: rn, reason: "同一檔內同一人出現多次而金額唔同" });
        continue;
      }
      seenInFile.set(m.guardId, val);
      const cur = byGuard.get(m.guardId);
      const source = row.note ? `manual:批量導入：${row.note}` : "manual:批量導入";
      if (cur && cur.voidedAt === null && Number(cur.avgDailyWage) === val && cur.source === source) {
        result.skipped_unchanged += 1;
        continue;
      }
      if (cur) result.updated += 1;
      else result.created += 1;
      if (dryRun || !db) continue;
      const after = await db.guardAvgWage.upsert({
        where: { guardId_month: { guardId: m.guardId, month } },
        create: { guardId: m.guardId, month, avgDailyWage: val, source, createdBy: actorUserId },
        update: { avgDailyWage: val, source, voidedAt: null },
      });
      await writeAuditTx(db, { actorUserId, tableName: "guard_avg_wages", rowId: after.id, action: "bulk_avg_wages", after: { month: month.toISOString().slice(0, 7), source: "manual", updated: !!cur }, ip });
    }
  };

  if (dryRun) {
    await assertMonthNotLocked({ workDate: month, actorUserId, tableName: "guard_avg_wages", rowId: "bulk", ip });
    await work(null);
  } else {
    await prisma.$transaction(
      async (tx) => {
        await assertMonthNotLockedTx(tx, { workDate: month, actorUserId, tableName: "guard_avg_wages", rowId: "bulk", ip });
        await work(tx);
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }
  return result;
}
