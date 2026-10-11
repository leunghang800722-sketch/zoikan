// P8.5：鎖月後推送每月修正摘要。觸發同 P8.3（month_closes.locked_at 新於 state.last_processed_lock_at，首次只處理最近 31 日內）：
// 對已鎖月份 buildOpsDigest()（現有 lib，純讀、無 PII：類別／盤名／雞頭代號／數字）→ 數字摘要（一定有）
// ＋可選 AI 摘要（現有 generateDigestSummary：同一個 provider／輸出 guard；冇 AI 設定、失敗、guard 觸發、或文字疑似含 PII 就只推數字摘要）。
// 通知老闆；同月只一次（dedupe）。AI 用量寫一行 ai_chat audit（actor null、by_job）。
import { prisma } from "@/lib/db";
import { monthLabel } from "@/lib/reports/money";
import { buildOpsDigest, type OpsDigest } from "@/lib/ops/digest";
import { generateDigestSummary } from "@/lib/ops/ai-summary";
import { isAiConfigured } from "@/lib/ai/config";
import { getLlmClient } from "@/lib/ai/llm";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify/create";
import { mergeJobState, readJobState } from "@/lib/scheduler/state";
import { getJobReaderSession } from "./session";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const LOCK_OPS_DIGEST_KEY = "lock_ops_digest";
const FIRST_RUN_WINDOW_MS = 31 * 86400000;

/** 數字摘要：全部由 digest 內數字砌（唔經 AI、唔含人名）。 */
export function numericDigestText(digest: OpsDigest): string {
  const groups = digest.groupTotals.filter((g) => g.count > 0 || g.prevCount > 0).map((g) => `${g.label} ${g.count}（上月 ${g.prevCount}）`);
  const b = digest.baseline;
  const base = [
    `一鍵結算 ${b.oneClick.runs} 次（完成 ${b.oneClick.doneRuns}、失敗 ${b.oneClick.failedRuns}）`,
    `未配對 ${b.unmatchedCells} 格、重名待確認 ${b.ambiguousCells} 格、只憑姓名配對 ${b.nameOnlyCells} 格`,
    `未定價 ${b.unpricedRecords} 更`,
    b.daysMonthEndToLock === null ? null : `月尾到鎖月 ${b.daysMonthEndToLock} 日`,
  ].filter((x): x is string => !!x);
  return `${digest.month} 每月修正摘要：${groups.length ? groups.join("、") : "本月冇記錄到修正"}。${base.join("；")}。`;
}

async function maybeAiSummary(digest: OpsDigest): Promise<string | null> {
  if (!isAiConfigured()) return null;
  try {
    const r = await generateDigestSummary(digest, getLlmClient());
    await writeAudit({ actorUserId: null, tableName: "ai_chat", rowId: LOCK_OPS_DIGEST_KEY, action: "ai_chat", after: { source: "ops_digest", by_job: LOCK_OPS_DIGEST_KEY, month: digest.month, input_tokens: r.inputTokens, output_tokens: r.outputTokens, guard_triggered: r.guardTriggered }, ip: null });
    if (r.guardTriggered || !r.text.trim()) return null;
    return r.text.trim().slice(0, 1200); // 通知內文有上限（真 provider 最多 8 句；防異常長輸出）
  } catch (e) {
    console.error("[lock_ops_digest] AI 摘要失敗（只推數字摘要）:", e instanceof Error ? e.name : "error");
    return null;
  }
}

export async function runLockOpsDigest(now: Date): Promise<JobResult> {
  const state = await readJobState(LOCK_OPS_DIGEST_KEY);
  const lastRaw = typeof state.last_processed_lock_at === "string" ? new Date(state.last_processed_lock_at) : null;
  const since = lastRaw && !Number.isNaN(lastRaw.getTime()) ? lastRaw : new Date(now.getTime() - FIRST_RUN_WINDOW_MS);
  const closes = await prisma.monthClose.findMany({ where: { lockedAt: { gt: since } }, orderBy: { lockedAt: "asc" }, select: { month: true, lockedAt: true } });
  if (closes.length === 0) return { status: "skipped", summary: { months: {} } };
  const session = await getJobReaderSession();
  const months: Record<string, { ai: boolean; notified: boolean }> = {};
  for (const c of closes) {
    const label = monthLabel(c.month);
    const fresh = await prisma.monthClose.findUnique({ where: { month: c.month }, select: { lockedAt: true } });
    if (fresh?.lockedAt && c.lockedAt) {
      const digest = await buildOpsDigest(c.month, session, now);
      const numeric = numericDigestText(digest);
      const ai = await maybeAiSummary(digest);
      const make = (text: string) => ({
        kind: "ops_digest_ready",
        title: `${label} 每月修正摘要`,
        body: text,
        href: `/reports/ops-digest?month=${label}`,
        audience: ["老闆"],
        dedupeKey: `ops_digest_ready:${label}`,
      });
      let usedAi = false;
      let r;
      if (ai) {
        try {
          r = await createNotification(make(`${numeric}\nAI 摘要：${ai}`));
          usedAi = true;
        } catch {
          r = undefined; // AI 文字疑似含個人資料（assertNoPii 拒絕）→ 退回只推數字摘要
        }
      }
      if (!r) r = await createNotification(make(numeric));
      months[label] = { ai: usedAi, notified: r.created };
    }
    await mergeJobState(LOCK_OPS_DIGEST_KEY, { last_processed_lock_at: c.lockedAt?.toISOString() });
  }
  return { summary: { months } };
}

export const lockOpsDigestJob: JobDef = {
  key: LOCK_OPS_DIGEST_KEY,
  label: "鎖月後推送每月修正摘要",
  description: "每 5 分鐘：有新鎖嘅月份就生成每月修正摘要（數字一定有，AI 摘要可選），通知老闆。唯讀；同月只推一次。",
  defaultSchedule: "*/5 * * * *",
  run: async (ctx) => runLockOpsDigest(ctx.now),
};
