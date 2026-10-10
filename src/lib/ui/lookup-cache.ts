// P3-2.4：前端參考資料（sites／brokers／shift-types／guards 輕量表）嘅模組級 in-memory cache。
// 範圍＝同一個瀏覽器分頁、同一個 JS 模組實例（整頁重載即清空）；TTL 60 s；
// 任何對相關資源嘅成功寫入（見 api-client.ts）或手動 `invalidateLookups()` 即全部作廢。
// 只放「慢變嘅參考資料」，**唔放任何報表／毛利數字**（老闆 2026-10-10 第 6 條）。
export const LOOKUP_TTL_MS = 60_000;

const cache = new Map<string, { at: number; p: Promise<unknown> }>();

export function cachedLookup<T>(key: string, load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const hit = cache.get(key);
  if (hit && now() - hit.at < LOOKUP_TTL_MS) return hit.p as Promise<T>;
  const p = load().catch((e) => {
    // 失敗唔記，下次重試
    if (cache.get(key)?.p === p) cache.delete(key);
    throw e;
  });
  cache.set(key, { at: now(), p });
  return p;
}

/** 手動作廢（新增／編輯盤、雞頭、保安員、更種之後 call；api-client 會對相關寫入自動 call）。 */
export function invalidateLookups(): void {
  cache.clear();
}

/** 呢啲路徑嘅成功寫入（POST／PATCH／PUT／DELETE）會令參考資料 cache 作廢。 */
const LOOKUP_WRITE_PATHS = /^\/api\/(guards|sites|brokers|shift-types|broker-site-assignments|month-closes|roster-uploads|guard-fix|staff-import|triage|months)(\/|\?|$)/;
export function isLookupWritePath(path: string): boolean {
  return LOOKUP_WRITE_PATHS.test(path);
}
