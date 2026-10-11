"use client";
// P13.1：分診題分頁載入（手機流動數據唔好一次過下載成個 session）。
// 只攞頭 TRIAGE_PAGE_SIZE 題就即刻顯示第一題；快到尾（dialog 話事）背景 prefetch 下一頁。
// 用 `GET /api/triage/sessions/:id?take=&cursor=&tier=`（counts 永遠係整個 session，唔受分頁影響）。
import { useCallback, useRef, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";

const TRIAGE_PAGE_SIZE = 5;

interface TriageCounts {
  open: number;
  answered: number;
  skipped: number;
  total: number;
  important_open: number;
  supplementary_open: number;
  restricted_open: number;
}
interface PageRes<Q> {
  session: { id: string; status: string; counts: TriageCounts };
  questions: Q[];
  next_cursor?: string | null;
}

export interface TriagePager<Q extends { id: string }> {
  /** null＝第一頁未到 */
  items: Q[] | null;
  counts: TriageCounts | null;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  /** 由頭重載第一頁（同時更新 counts） */
  reload: () => Promise<void>;
  /** 攞下一頁（冇下一頁／攞緊就唔做） */
  loadMore: () => Promise<void>;
  /** 輕量：淨更新 counts（take=0） */
  refreshCounts: () => Promise<void>;
  /** 本地移走一題（答咗／跳過） */
  drop: (id: string) => void;
}

export function useTriagePager<Q extends { id: string }>(sessionId: string, opts: { tier?: "important" | "supplementary"; status?: string } = {}): TriagePager<Q> {
  const { tier, status = "open" } = opts;
  const [items, setItems] = useState<Q[] | null>(null);
  const [counts, setCounts] = useState<TriageCounts | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const gen = useRef(0);

  const url = useCallback(
    (take: number, cur: string | null) => `/api/triage/sessions/${sessionId}?status=${status}&take=${take}${tier ? `&tier=${tier}` : ""}${cur ? `&cursor=${encodeURIComponent(cur)}` : ""}`,
    [sessionId, status, tier],
  );

  const reload = useCallback(async () => {
    const g = ++gen.current;
    busy.current = true;
    const res = await apiGet<PageRes<Q>>(url(TRIAGE_PAGE_SIZE, null));
    if (g !== gen.current) return;
    busy.current = false;
    setLoadingMore(false);
    if (!res.ok) {
      setError(res.message);
      setItems([]);
      cursor.current = null;
      setHasMore(false);
      return;
    }
    setError(null);
    setItems(res.data.questions);
    setCounts(res.data.session.counts);
    cursor.current = res.data.next_cursor ?? null;
    setHasMore(!!res.data.next_cursor);
  }, [url]);

  const loadMore = useCallback(async () => {
    const cur = cursor.current;
    if (!cur || busy.current) return;
    const g = gen.current;
    busy.current = true;
    setLoadingMore(true);
    const res = await apiGet<PageRes<Q>>(url(TRIAGE_PAGE_SIZE, cur));
    if (g !== gen.current) return;
    busy.current = false;
    setLoadingMore(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setItems((prev) => {
      const seen = new Set((prev ?? []).map((x) => x.id));
      return [...(prev ?? []), ...res.data.questions.filter((x) => !seen.has(x.id))];
    });
    // counts 只喺 reload／refreshCounts 更新（dialog 用「counts－之後答咗幾多」計剩餘，分頁中途換 counts 會計錯）
    cursor.current = res.data.next_cursor ?? null;
    setHasMore(!!res.data.next_cursor);
  }, [url]);

  const refreshCounts = useCallback(async () => {
    const res = await apiGet<PageRes<Q>>(url(0, null));
    if (res.ok) setCounts(res.data.session.counts);
  }, [url]);

  const drop = useCallback((id: string) => setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev)), []);

  return { items, counts, hasMore, loadingMore, error, reload, loadMore, refreshCounts, drop };
}
