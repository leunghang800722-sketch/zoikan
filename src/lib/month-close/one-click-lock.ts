// 一鍵結算全域 advisory lock key（自己一個 key，唔同 guard-fix(...925)／reconcile-all(...926)）。
// 獨立檔：historical.ts（標記歷史月份）要同一把鎖防並發，但唔想 import 成個 one-click.ts（循環依賴）。
export const ONE_CLICK_ADVISORY_LOCK_KEY = 7_710_270_927;
