// HIST-1：歷史月份標記（month_closes.historical）。歷史月份（2026-07 前）只用嚟上載更表＋對數＋落更（shift_records 含 SL／AL／SH），
// 由更表計病假／年假結餘（scripts/db/leave-opening-from-rosters.ts）；**唔跑**月結（一鍵結算）／糧／介紹費／鎖月，
// 排程 job（auto_one_click／nightly_month_health／longterm_input_drafts）、月結健康、診斷、ops digest 全部跳過。
// 冇 month_closes 行嘅月份＝非歷史（行為同以前一樣）；標記要經 POST /api/month-closes { historical: true } 建立。
import { prisma } from "@/lib/db";
import { monthStart } from "@/lib/month-lock";
import type { Prisma } from "@prisma/client";
import { ApiError, Conflict } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";
import { ONE_CLICK_ADVISORY_LOCK_KEY } from "./one-click-lock";

export async function isHistoricalMonth(month: Date): Promise<boolean> {
  const mc = await prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { historical: true } });
  return !!mc?.historical;
}

/** 全部歷史月份嘅 month 毫秒（UTC 月初），俾 job／列表過濾用。 */
export async function historicalMonthKeys(): Promise<Set<number>> {
  const rows = await prisma.monthClose.findMany({ where: { historical: true }, select: { month: true } });
  return new Set(rows.map((r) => r.month.getTime()));
}

/** 歷史月份唔准跑月結／糧／鎖月／健康體檢：409 `historical_month`。 */
export async function assertNotHistoricalMonth(month: Date, what: string): Promise<void> {
  if (await isHistoricalMonth(month)) {
    throw new ApiError(409, "historical_month", `${monthStart(month).toISOString().slice(0, 7)} 係歷史月份（只用嚟上載更表計假期結餘），唔做${what}`);
  }
}

// ---------------------------------------------------------------------------
// HIST-1.1：標記／取消歷史月份嘅限制與並發保護
// ---------------------------------------------------------------------------

/** 歷史月份只可標早過呢個月（2026-07-01，即 7 月起已經係正式月結月份，唔可以標）。 */
export const HIST_MAX_MONTH = new Date(Date.UTC(2026, 6, 1));

type Tx = Prisma.TransactionClient;

/** 標記前置檢查（tx 內，已攞一鍵結算 advisory lock）：早過 HIST_MAX_MONTH、未鎖、冇一鍵結算 run、冇未作廢長工糧 run。 */
async function assertMarkable(tx: Tx, month: Date, existing: { lockedAt: Date | null } | null): Promise<void> {
  if (month.getTime() >= HIST_MAX_MONTH.getTime()) throw Conflict(`歷史月份只可標早過 ${HIST_MAX_MONTH.toISOString().slice(0, 7)} 嘅月份`);
  if (existing?.lockedAt) throw Conflict("呢個月已經鎖定，唔可以標做歷史月份");
  if ((await tx.monthCloseRun.count({ where: { month } })) > 0) throw Conflict("呢個月做過一鍵結算，唔可以標做歷史月份");
  if ((await tx.longtermPayrollRun.count({ where: { month, voidedAt: null } })) > 0) throw Conflict("呢個月有未作廢嘅長工糧，唔可以標做歷史月份");
}

/** 標記歷史月份（建新行或就地標記）。全程喺 tx 內，先攞一鍵結算 advisory lock（同 POST one-click 共用 key）防並發。 */
export async function markHistoricalMonth(month: Date, actorUserId: string, opts: { rosterVersionNote?: string | null; ip: string | null }): Promise<{ row: Prisma.MonthCloseGetPayload<object>; created: boolean }> {
  const m = monthStart(month);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
    const existing = await tx.monthClose.findUnique({ where: { month: m } });
    await assertMarkable(tx, m, existing);
    if (existing) {
      const row = await tx.monthClose.update({ where: { id: existing.id }, data: { historical: true } });
      await writeAuditTx(tx, { actorUserId, tableName: "month_closes", rowId: row.id, action: "update", before: existing, after: row, ip: opts.ip });
      return { row, created: false };
    }
    const row = await tx.monthClose.create({ data: { month: m, rosterVersionNote: opts.rosterVersionNote ?? null, historical: true, createdBy: actorUserId } });
    await writeAuditTx(tx, { actorUserId, tableName: "month_closes", rowId: row.id, action: "create", after: row, ip: opts.ip });
    return { row, created: true };
  });
}

/** 取消歷史標記（老闆）：historical → false，寫 audit。已鎖月（理論上唔會）都唔郁。 */
export async function unmarkHistoricalMonth(id: string, actorUserId: string, ip: string | null): Promise<Prisma.MonthCloseGetPayload<object>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
    const existing = await tx.monthClose.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "not_found", "搵唔到呢個月份");
    if (!existing.historical) throw Conflict("呢個月唔係歷史月份");
    const row = await tx.monthClose.update({ where: { id }, data: { historical: false } });
    await writeAuditTx(tx, { actorUserId, tableName: "month_closes", rowId: id, action: "update", before: existing, after: row, ip });
    return row;
  });
}
