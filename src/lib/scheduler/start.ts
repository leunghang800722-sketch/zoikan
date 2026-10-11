// P7.1：排程器啟動（由 src/instrumentation.ts 喺 Node runtime 呼叫）。每分鐘一個 tick；tick 內部有
// PG advisory lock＋claim，多 instance 同時起都唔會重跑。
import { JOBS } from "@/lib/jobs/registry";
import { tick } from "./runner";

const g = globalThis as unknown as { __zoikanScheduler?: { timer: NodeJS.Timeout; busy: boolean } };

/** SCHEDULER_ENABLED：`0`／`false`／`off` 關；`1`／`true`／`on` 開；冇設＝production 開、其他環境（dev／test）關。 */
export function isSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SCHEDULER_ENABLED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  return env.NODE_ENV === "production";
}

export function startScheduler(intervalMs = 60_000): void {
  if (g.__zoikanScheduler) return; // HMR／重複 register 保護
  const state = { timer: undefined as unknown as NodeJS.Timeout, busy: false };
  const run = async () => {
    if (state.busy) return; // 上一個 tick 未完（長 job）就跳過
    state.busy = true;
    try {
      await tick(JOBS);
    } catch (e) {
      console.error("[scheduler] tick 失敗:", e instanceof Error ? e.name : "error");
    } finally {
      state.busy = false;
    }
  };
  state.timer = setInterval(run, intervalMs);
  state.timer.unref?.();
  setTimeout(run, 15_000).unref?.();
  g.__zoikanScheduler = state;
  console.log("[scheduler] started");
}
