// W1：WhatsApp 解析 job；W2 開 Triage 題；W3 群組開咗自動寫入就經共用 write service 寫入（見 process.ts／autowrite.ts）。
// 排程器最細粒度係 1 分鐘（5 欄 cron），所以每分鐘跑一次、每次連續處理到冇待處理訊息或用盡時間預算
// （取代簡報嘅「每 30 秒」）。WA_ENABLED=1 先跑；scheduler 有 PG advisory lock 防並發。
import { prisma } from "@/lib/db";
import { waEnabled } from "@/lib/whatsapp/config";
import { failAttempt, loadRunContext, markRevokedIntents, processWhatsappMessage, type ProcessStats } from "@/lib/whatsapp/process";
import { supersedeRevokedWaQuestions } from "@/lib/whatsapp/triage";
import { followUpRevokedWrites } from "@/lib/whatsapp/source-change";
import { ensureSystemUser } from "@/lib/system-user";
import { computeStats, parseRange } from "@/lib/whatsapp/stats";
import { addDays, hkDateOf } from "@/lib/whatsapp/dates";
import { createNotification } from "@/lib/notify/create";
import type { LlmClient } from "@/lib/ai/llm";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const WHATSAPP_PARSE_KEY = "whatsapp_parse";
const WHATSAPP_DAILY_KEY = "whatsapp_daily_summary";
const BATCH = 20;
/** 單次 run 時間預算（毫秒）：超過就唔再攞新訊息，留俾下一分鐘。 */
const WA_PARSE_BUDGET_MS = 45_000;

export async function runWhatsappParse(now: Date, opts: { llm?: LlmClient[]; budgetMs?: number; force?: boolean } = {}): Promise<JobResult> {
  if (!opts.force && !waEnabled()) return { status: "skipped", summary: { enabled: false } };
  const started = Date.now();
  const budget = opts.budgetMs ?? WA_PARSE_BUDGET_MS;
  const revoked = await markRevokedIntents(now);
  // W2：已撤回訊息嘅 open 分診題 → superseded（冪等）
  const revokedQs = await supersedeRevokedWaQuestions();
  // W3：已撤回訊息已寫入而仍 pending_approval 嘅記錄 → 自動退回（先查再開系統帳號，冇嘢要做就唔動 DB）
  const hasRevokedPending = (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM shift_records WHERE source = 'whatsapp' AND status = 'pending_approval' AND provenance->>'message_id' IN (SELECT message_id FROM whatsapp_messages WHERE revoked_at IS NOT NULL)`)[0]?.n;
  const revokedRejected = hasRevokedPending && Number(hasRevokedPending) > 0 ? await followUpRevokedWrites(await ensureSystemUser()) : 0;
  const counts = { processed: 0, ignored: 0, routed: 0, retry: 0, error: 0, stale: 0, skipped: 0 };
  const stats: ProcessStats = { intents: 0, autoWrite: 0, triage: 0, ignoredIntents: 0, llmIn: 0, llmOut: 0 };
  const attempted = new Set<string>();
  // 冇待處理訊息就唔使載入全部保安員索引（job 每分鐘跑）
  if (revoked === 0 && revokedRejected === 0 && (await prisma.whatsappMessage.count({ where: { status: "received", revokedAt: null } })) === 0) return { status: "skipped", summary: { ...counts, revoked_marked: 0, revoked_rejected: 0, backlog: 0 } };
  const ctxBase = await loadRunContext();
  const ctx = { ...ctxBase, ...(opts.llm ? { llm: opts.llm } : {}) };
  while (Date.now() - started < budget) {
    const rows = await prisma.whatsappMessage.findMany({ where: { status: "received", revokedAt: null, id: { notIn: [...attempted] } }, orderBy: [{ ts: "asc" }, { id: "asc" }], take: BATCH, select: { id: true } });
    if (rows.length === 0) break;
    for (const r of rows) {
      if (Date.now() - started >= budget) break;
      attempted.add(r.id);
      let outcome: keyof typeof counts | "retry" = "skipped";
      try {
        outcome = await processWhatsappMessage(r.id, ctx, stats);
      } catch {
        // 任何例外都計一次失敗（3 次 → error），唔可以無限重試打 LLM
        const cur = await prisma.whatsappMessage.findUnique({ where: { id: r.id }, select: { revision: true } }).catch(() => null);
        outcome = cur ? await failAttempt(r.id, cur.revision, "process_failed").catch(() => "retry" as const) : "retry";
      }
      counts.processed++;
      counts[outcome]++;
    }
  }
  const left = await prisma.whatsappMessage.count({ where: { status: "received", revokedAt: null } });
  return {
    status: counts.processed === 0 && revoked === 0 && revokedRejected === 0 ? "skipped" : "ok",
    summary: { ...counts, revoked_marked: revoked, revoked_questions: revokedQs, revoked_rejected: revokedRejected, intents: stats.intents, auto_write: stats.autoWrite, triage: stats.triage, ignored_intents: stats.ignoredIntents, llm_tokens_in: stats.llmIn, llm_tokens_out: stats.llmOut, backlog: left },
  };
}

export const whatsappParseJob: JobDef = {
  key: WHATSAPP_PARSE_KEY,
  label: "WhatsApp 報更解析＋自動寫入",
  description: "每分鐘處理新收到嘅 WhatsApp 群組訊息：規則過濾 → AI 抽取 → 程式碼配對 → 已開自動寫入嘅群組寫入更表（待批核）／其餘分流。WA_ENABLED=1 先跑。",
  defaultSchedule: "* * * * *",
  run: async (ctx) => runWhatsappParse(ctx.now),
};

/** 每日摘要（老闆）：前一個香港日嘅收／過濾／解析／分流計數。只有數字。 */
export async function runWhatsappDailySummary(now: Date, opts: { force?: boolean } = {}): Promise<JobResult> {
  if (!opts.force && !waEnabled()) return { status: "skipped", summary: { enabled: false } };
  const day = addDays(hkDateOf(now), -1);
  const s = await computeStats(parseRange(day, day, now), null);
  if (s.received === 0) return { status: "skipped", summary: { day, received: 0 } };
  const rate = s.consistency_rate === null ? "—" : `${Math.round(s.consistency_rate * 100)}%`;
  const r = await createNotification({
    kind: "whatsapp_daily",
    title: `WhatsApp 報更日摘要 ${day}`,
    body: `收 ${s.received}、過濾 ${s.filtered}、解析 ${s.parsed}；建議自動 ${s.auto_write}、分流 ${s.triage}、忽略 ${s.ignored}；自動寫入 ${s.auto_results.written}、待批 ${s.auto_results.pending}、拒絕 ${s.auto_results.rejected}；對照一致率 ${rate}。`,
    href: "/whatsapp/intents",
    audience: ["老闆"],
    dedupeKey: `whatsapp_daily:${day}`,
  });
  return { summary: { day, received: s.received, filtered: s.filtered, parsed: s.parsed, auto_write: s.auto_write, triage: s.triage, ignored: s.ignored, auto_written: s.auto_results.written, auto_pending: s.auto_results.pending, auto_rejected: s.auto_results.rejected, notified: r.created } };
}

export const whatsappDailySummaryJob: JobDef = {
  key: WHATSAPP_DAILY_KEY,
  label: "WhatsApp 報更日摘要",
  description: "每日 09:00 通知老闆前一日 WhatsApp 報更計數（收／過濾／解析／分流／對照一致率）。唔含個人資料。",
  defaultSchedule: "0 9 * * *",
  run: async (ctx) => runWhatsappDailySummary(ctx.now),
};
