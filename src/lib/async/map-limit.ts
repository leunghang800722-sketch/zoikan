// P3-1.5：細 helper（唔加依賴）——最多 `limit` 個並發跑 `fn`，結果次序同輸入一致。
// 任何一個 reject 就整個 reject（同 Promise.all 一致）；reject 後唔再開新工作。
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
