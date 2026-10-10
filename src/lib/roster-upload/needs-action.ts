// P3-3.5：更表上載列表「有嘢要做」判斷（純函數，client 頁同 unit test 共用）。
// 有上載而且：盤名未配對／解析失敗／未對數確認（uploaded、parsed）／仲有未配對或多重配對保安員。
// 已對數確認晒、冇未配對嘅盤，同未上載嘅盤，預設摺埋。
export interface NeedsActionEntry {
  site_id: string | null;
  upload: {
    status: string;
    parse_summary: { unmatched_guard_count?: number; ambiguous_guard_count?: number } | null;
  } | null;
}

export function needsAction(entry: NeedsActionEntry): boolean {
  const u = entry.upload;
  if (!u) return false;
  if (!entry.site_id) return true;
  if (u.status === "parse_failed" || u.status === "uploaded" || u.status === "parsed") return true;
  const sum = u.parse_summary;
  return (sum?.unmatched_guard_count ?? 0) > 0 || (sum?.ambiguous_guard_count ?? 0) > 0;
}
