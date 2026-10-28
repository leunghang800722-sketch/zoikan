// 一鍵結算全域 advisory lock key（自己一個 key，唔同 guard-fix(...925)／reconcile-all(...926)）。
// 獨立檔：historical.ts（標記歷史月份）要同一把鎖防並發，但唔想 import 成個 one-click.ts（循環依賴）。
export const ONE_CLICK_ADVISORY_LOCK_KEY = 7_710_270_927;

/** HIST-2：歷史月份一鍵導入嘅卡死門檻。一個月 ~30 份檔，guard-fix 單個 tx 上限 20 分鐘，所以用 30 分鐘（唔用一鍵結算嘅 15 分鐘），
 * 避免仍在正常執行嘅 run 被誤判卡死而令兩個 run 並行。一鍵結算 POST／rerun 同歷史導入 claim 都用呢個值判斷「歷史導入 run 未卡死」。 */
export const HIST_IMPORT_STALE_MS = 30 * 60 * 1000;
