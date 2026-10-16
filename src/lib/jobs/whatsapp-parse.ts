// W1：WhatsApp 解析 job（dry-run：只記錄建議，唔寫 shift_records、唔開 Triage 題）。
// 排程器最細粒度係 1 分鐘（5 欄 cron），所以每分鐘跑一次、每次連續處理到冇待處理訊息或用盡時間預算
// （取代簡報嘅「每 30 秒」）。WA_ENABLED=1 先跑；scheduler 有 PG advisory lock 防並發。
import { prisma } from "@/lib/db";
import { waEnabled } from "@/lib/whatsapp/config";
import { loadRunContext, markRevokedIntents, processWhatsappMessage, type ProcessStats } from "@/lib/whatsapp/process";
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
  const counts = { processed: 0, ignored: 0, routed: 0, retry: 0, error: 0, stale: 0, skipped: 0 };
  const stats: ProcessStats = { intents: 0, autoWrite: 0, triage: 0, ignoredIntents: 0, llmIn: 0, llmOut: 0 };
  const attempted = new Set<string>();
  // 冇待處理訊息就唔使載入全部保安員索引（job 每分鐘跑）
  if (revoked === 0 && (await prisma.whatsappMessage.count({ where: { status: "received", revokedAt: null } })) === 0) return { status: "skipped", summary: { ...counts, revoked_marked: 0, backlog: 0 } };
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
        outcome = "retry";
      }
      counts.processed++;
      counts[outcome]++;
    }
  }
  const left = await prisma.whatsappMessage.count({ where: { status: "received", revokedAt: null } });
  return {
    status: counts.processed === 0 && revoked === 0 ? "skipped" : "ok",
    summary: { ...counts, revoked_marked: revoked, intents: stats.intents, auto_write: stats.autoWrite, triage: stats.triage, ignored_intents: stats.ignoredIntents, llm_tokens_in: stats.llmIn, llm_tokens_out: stats.llmOut, backlog: left },
  };
}

export const whatsappParseJob: JobDef = {
  key: WHATSAPP_PARSE_KEY,
  label: "WhatsApp 報更解析（dry-run）",
  description: "每分鐘處理新收到嘅 WhatsApp 群組訊息：規則過濾 → AI 抽取 → 程式碼配對 → 記錄建議（唔寫更表）。WA_ENABLED=1 先跑。",
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
    body: `收 ${s.received}、過濾 ${s.filtered}、解析 ${s.parsed}；建議自動 ${s.auto_write}、分流 ${s.triage}、忽略 ${s.ignored}；對照一致率 ${rate}。`,
    href: "/whatsapp/intents",
    audience: ["老闆"],
    dedupeKey: `whatsapp_daily:${day}`,
  });
  return { summary: { day, received: s.received, filtered: s.filtered, parsed: s.parsed, auto_write: s.auto_write, triage: s.triage, ignored: s.ignored, notified: r.created } };
}

export const whatsappDailySummaryJob: JobDef = {
  key: WHATSAPP_DAILY_KEY,
  label: "WhatsApp 報更日摘要",
  description: "每日 09:00 通知老闆前一日 WhatsApp 報更計數（收／過濾／解析／分流／對照一致率）。唔含個人資料。",
  defaultSchedule: "0 9 * * *",
  run: async (ctx) => runWhatsappDailySummary(ctx.now),
};
