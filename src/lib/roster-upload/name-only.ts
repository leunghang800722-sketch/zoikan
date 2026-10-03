// WP-STAFF-IMPORT B2：淨靠姓名配對（`roster_upload_rows.match_basis='name_only'`）格數——
// 上載詳情頁、pending-summary、一鍵結算 precheck 共用。只計有配到人（guard_id 非 null）嘅格。
import { prisma } from "@/lib/db";

export const NAME_ONLY_WARNING = "淨靠姓名配對，建議補工號或電話";

/** uploadId → name_only 格數（只列 >0 嘅）。 */
export async function nameOnlyCountsByUpload(uploadIds: readonly string[]): Promise<Map<string, number>> {
  if (uploadIds.length === 0) return new Map();
  const grouped = await prisma.rosterUploadRow.groupBy({
    by: ["uploadId"],
    where: { uploadId: { in: [...uploadIds] }, matchBasis: "name_only", guardId: { not: null } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.uploadId, g._count._all]));
}

export interface NameOnlySummary {
  total: number;
  entries: { upload_id: string; site_name: string; month: string; name_only_count: number }[];
  warning: string;
}

/** pending-summary 用：status=parsed 嘅上載（month=null＝所有月份）各自 name_only 格數。 */
export async function buildNameOnlySummary(month: Date | null): Promise<NameOnlySummary> {
  const uploads = await prisma.rosterUpload.findMany({
    where: { ...(month ? { month } : {}), status: "parsed" },
    select: { id: true, siteNameRaw: true, month: true },
  });
  const counts = await nameOnlyCountsByUpload(uploads.map((u) => u.id));
  const entries = uploads
    .filter((u) => (counts.get(u.id) ?? 0) > 0)
    .map((u) => ({ upload_id: u.id, site_name: u.siteNameRaw, month: u.month.toISOString().slice(0, 7), name_only_count: counts.get(u.id)! }))
    .sort((a, b) => b.name_only_count - a.name_only_count);
  return { total: entries.reduce((a, e) => a + e.name_only_count, 0), entries, warning: NAME_ONLY_WARNING };
}
