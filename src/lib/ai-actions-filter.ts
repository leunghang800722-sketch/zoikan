// WP-AI-DIAG（§37.4）：建議動作卡嘅 server 側鎖月過濾——`one_click_run`／`backfill_from_postorder` 查該月有冇 lock
// （用現有 `isMonthLocked()`，唔新寫 SQL），鎖咗就丟棄；其餘寫入 type 靠現有 API 本身嘅鎖月檢查（唔改 API）。
// 擺喺 `src/lib/` 頂層（唔喺 `src/lib/ai/` 樹入面），因為要經 `month-lock` 讀 DB；chat route 只 import 呢個 function。
import { isMonthLocked } from "./month-lock";
import { checkOutputGuard } from "./ai/output-guard";
import { MONTH_LOCK_FILTERED_TYPES, type ActionCard } from "./ai/actions";

function monthStringToDate(month: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

/** 鎖咗嘅月份嘅寫入卡丟棄；查鎖失敗（DB 問題）亦保守丟棄該卡。 */
export async function dropLockedMonthActions(actions: ActionCard[]): Promise<ActionCard[]> {
  const out: ActionCard[] = [];
  const cache = new Map<string, boolean>();
  for (const a of actions) {
    if (!MONTH_LOCK_FILTERED_TYPES.includes(a.type)) {
      out.push(a);
      continue;
    }
    const month = (a.params as { month: string }).month;
    let locked = cache.get(month);
    if (locked === undefined) {
      try {
        locked = await isMonthLocked(monthStringToDate(month));
      } catch {
        locked = true;
      }
      cache.set(month, locked);
    }
    if (!locked) out.push(a);
  }
  return out;
}

/** 逐張卡嘅 label＋basis 跑純函數 `checkOutputGuard`（DML／指示性文字），中咗就丟嗰張（唔影響其他卡）。 */
export function dropGuardedActions(actions: ActionCard[]): ActionCard[] {
  return actions.filter((a) => !checkOutputGuard(`${a.label}\n${a.basis}`).triggered);
}
