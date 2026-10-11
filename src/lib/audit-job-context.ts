// P8 驗收 M1：排程 job 執行期間（AsyncLocalStorage）所有 audit_log 寫入自動帶 `after.by_job=<job key>`，
// 唔使逐個 call site 加（一鍵結算 run 內部有十幾條寫 audit 嘅路徑）。可選 `actorUserId`：
// 該 job 期間 actor 為 null 嘅 audit（舊 lib 一向寫 null）補上系統帳號，令審計一致。
import { AsyncLocalStorage } from "node:async_hooks";

interface Ctx {
  jobKey: string;
  actorUserId?: string;
}
const store = new AsyncLocalStorage<Ctx>();

export function withAuditJob<T>(jobKey: string, fn: () => Promise<T>, actorUserId?: string): Promise<T> {
  return store.run({ jobKey, actorUserId }, fn);
}

export function currentAuditJob(): string | undefined {
  return store.getStore()?.jobKey;
}

export function currentAuditJobActor(): string | undefined {
  return store.getStore()?.actorUserId;
}
