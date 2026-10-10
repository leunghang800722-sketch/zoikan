// `GET /api/roster-uploads/pending-summary` 嘅純讀核心（Opus 5.5 驗收建議
// 2026-09-28：抽做 lib，等 `scripts/perf/snapshot.ts` 可以同 route 用同一份
// code 做優化前後快照）。逐上載列「已上載但未對數完成」（status=parsed，
// 仲有非 match 項未有 keep_system／exception 決定）嘅數量。`month=null`
// ＝所有月份。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hkMonthStart } from "@/lib/dates";
import { mapLimit } from "@/lib/async/map-limit";
import { loadReconcileInputs, reconcileRosterUpload } from "@/lib/roster-upload/reconcile";

/** 不帶 month 時預設只計「本月＋上月」（首頁用法）；`months=0` ＝所有月份（舊行為）。 */
export const PENDING_SUMMARY_DEFAULT_MONTHS = 2;

/** P3-1.5：pending-summary／name-only 共用嘅上載範圍（status=parsed）。
 * 帶 month ＝淨係嗰個月（舊行為，`months` 唔生效）；冇帶 month：`months>0` ＝由「本月往前數 months 個月」起
 * （本月＋上月＝2），`months=0` ＝全部月份。 */
export function pendingUploadWhere(month: Date | null, months: number = PENDING_SUMMARY_DEFAULT_MONTHS, now: Date = new Date()): Prisma.RosterUploadWhereInput {
  if (month) return { month, status: "parsed" };
  if (months > 0) {
    const cur = hkMonthStart(now);
    const from = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - (months - 1), 1));
    return { month: { gte: from }, status: "parsed" };
  }
  return { status: "parsed" };
}

const RECONCILE_CHUNK = 15; // 每批上載共用一組 IN 查詢
const RECONCILE_CONCURRENCY = 4;

export interface PendingSummaryEntry {
  site_id: string | null;
  site_name: string;
  upload_id: string;
  month: string;
  pending_count: number;
}

export interface PendingSummaryResult {
  month: string | null;
  entries: PendingSummaryEntry[];
  total: number;
}

export async function buildPendingSummary(month: Date | null, opts: { months?: number } = {}): Promise<PendingSummaryResult> {
  const uploads = await prisma.rosterUpload.findMany({
    where: pendingUploadWhere(month, opts.months),
    select: { id: true, siteId: true, siteNameRaw: true, month: true },
  });

  // 效能優化（老闆 2026-09-28 指令）：決定記錄一次過攞齊（原本逐上載一條）。
  const allDecisions = uploads.length
    ? await prisma.rosterReconcileDecision.findMany({ where: { uploadId: { in: uploads.map((u) => u.id) } }, select: { uploadId: true, reconcileKey: true } })
    : [];
  const decidedByUpload = new Map<string, Set<string>>();
  for (const d of allDecisions) {
    const set = decidedByUpload.get(d.uploadId);
    if (set) set.add(d.reconcileKey);
    else decidedByUpload.set(d.uploadId, new Set([d.reconcileKey]));
  }

  // P3-1.5：上載分批（每批共用一組 IN 查詢，見 `loadReconcileInputs()`），批與批之間最多 4 併發；
  // 對數用純函數 `reconcileRosterUpload()`，結果同逐份 `reconcileUpload()` 一致。
  const chunks: (typeof uploads)[] = [];
  for (let i = 0; i < uploads.length; i += RECONCILE_CHUNK) chunks.push(uploads.slice(i, i + RECONCILE_CHUNK));
  const pendingByUpload = new Map<string, number>();
  await mapLimit(chunks, RECONCILE_CONCURRENCY, async (chunk) => {
    const inputs = await loadReconcileInputs(chunk.map((u) => u.id));
    for (const u of chunk) {
      const items = reconcileRosterUpload(inputs.get(u.id)!);
      // 驗收修正：同 apply 嘅「未處理」定義一致——已經有 keep_system／
      // exception 決定嘅項唔再計做待處理。
      const decided = decidedByUpload.get(u.id) ?? new Set<string>();
      pendingByUpload.set(u.id, items.filter((i) => i.category !== "match" && !decided.has(i.key)).length);
    }
  });

  const entries: PendingSummaryEntry[] = [];
  for (const u of uploads) {
    const pending = pendingByUpload.get(u.id) ?? 0;
    if (pending > 0) entries.push({ site_id: u.siteId, site_name: u.siteNameRaw, upload_id: u.id, month: u.month.toISOString().slice(0, 7), pending_count: pending });
  }
  entries.sort((a, b) => b.pending_count - a.pending_count);
  return { month: month ? month.toISOString().slice(0, 7) : null, entries, total: entries.reduce((a, e) => a + e.pending_count, 0) };
}
