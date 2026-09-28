// `GET /api/roster-uploads/pending-summary` 嘅純讀核心（Opus 5.5 驗收建議
// 2026-09-28：抽做 lib，等 `scripts/perf/snapshot.ts` 可以同 route 用同一份
// code 做優化前後快照）。逐上載列「已上載但未對數完成」（status=parsed，
// 仲有非 match 項未有 keep_system／exception 決定）嘅數量。`month=null`
// ＝所有月份。
import { prisma } from "@/lib/db";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";

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

export async function buildPendingSummary(month: Date | null): Promise<PendingSummaryResult> {
  const uploads = await prisma.rosterUpload.findMany({
    where: { ...(month ? { month } : {}), status: "parsed" },
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
  const entries: PendingSummaryEntry[] = [];
  for (const u of uploads) {
    const { items } = await reconcileUpload(u.id);
    // 驗收修正：同 apply 嘅「未處理」定義一致——已經有 keep_system／
    // exception 決定嘅項唔再計做待處理。
    const decided = decidedByUpload.get(u.id) ?? new Set<string>();
    const pending = items.filter((i) => i.category !== "match" && !decided.has(i.key)).length;
    if (pending > 0) entries.push({ site_id: u.siteId, site_name: u.siteNameRaw, upload_id: u.id, month: u.month.toISOString().slice(0, 7), pending_count: pending });
  }
  entries.sort((a, b) => b.pending_count - a.pending_count);
  return { month: month ? month.toISOString().slice(0, 7) : null, entries, total: entries.reduce((a, e) => a + e.pending_count, 0) };
}
