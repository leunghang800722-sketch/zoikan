// P3-2.1（P3 §3.1 P6／附錄 b A-4／A-13）：報表 request-scoped 記憶化。
//
// 同一個 request（或同一個一鍵結算 run 嘅一段步驟）入面，`buildMonthlyClose`／
// `buildGrossMargin`／`buildLongtermSalaryAllocation`／`buildPayrollTotals`
// 會被多個報表互相內嵌、各自再叫（月結工作台入頁同一月 ×4、一鍵 step6 ×3）。
// 呢度用 `AsyncLocalStorage<Map<key, Promise>>` 令「同一 context 內、同一 key」
// 只計一次，之後直接共用同一個 Promise（結果物件唔會被 caller 改動，已逐個核對）。
//
// 硬規則（老闆 2026-10-10 第 6 條）：**絕對唔跨 request 存**——Map 隨 context
// 結束被 GC，冇任何模組級 cache／TTL。冇 context 時（script、test 直接叫）
// 每次都直接計，行為同改動前完全一樣。
//
// `withReportContext` 永遠開一個**全新** Map（巢狀都係新嘅，唔承接外層）：
// 咁 AI 工具／一鍵結算每段步驟可以喺自己嘅 scope 內 memo，而唔會讀到外層
// 較早時間點計出嚟、其後因寫入而過時嘅結果。有寫入之後要重讀，就叫
// `invalidateReportMemo()`。
import { AsyncLocalStorage } from "node:async_hooks";

type Store = Map<string, Promise<unknown>>;
const als = new AsyncLocalStorage<Store>();

/** 實際執行（未命中 memo 或冇 context）嘅次數，按 key 前綴（`close`／`margin`…）計。
 * 純粹俾 test／量度用；唔影響行為。 */
const computeCounts = new Map<string, number>();
export function getReportComputeCounts(): Record<string, number> {
  return Object.fromEntries(computeCounts);
}
export function resetReportComputeCounts(): void {
  computeCounts.clear();
}

export function withReportContext<T>(fn: () => Promise<T>): Promise<T> {
  return als.run(new Map(), fn);
}

/** 而家 async 鏈所屬嘅 memo Map（冇 context 回 undefined）。純粹俾守護 test 驗證「run 開咗自己嘅全新 context」，業務 code 唔好用。 */
export function currentReportMemoStore(): Map<string, Promise<unknown>> | undefined {
  return als.getStore();
}

export function invalidateReportMemo(): void {
  als.getStore()?.clear();
}

export function memoized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prefix = key.split(":")[0]!;
  const run = () => {
    computeCounts.set(prefix, (computeCounts.get(prefix) ?? 0) + 1);
    return fn();
  };
  const store = als.getStore();
  if (!store) return run();
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;
  const p = run();
  store.set(key, p);
  return p;
}
