// P7.1：排程核心。tick 每分鐘跑：揾到期 job → PG advisory lock（防多 instance／run-now 同時跑）
// → 認領（next_run_at 先推進，防重跑）→ 執行 → 寫 job_runs 同 scheduled_jobs.last_*。
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { nextRun, isValidCron } from "./cron";
import { withJobLock } from "./lock";
import { ensureSystemUser } from "@/lib/system-user";
import { withAuditJob } from "@/lib/audit-job-context";
import { createNotification } from "@/lib/notify/create";
import type { JobDef, JobResult } from "./types";

export type RunOutcome =
  | { outcome: "ran"; runId: string; status: "ok" | "error" | "skipped" | "timeout"; summary: Record<string, unknown> | null; error?: string }
  | { outcome: "skipped_locked" }
  | { outcome: "not_due" }
  | { outcome: "unknown_job" };

const MAX_ERROR_LEN = 500;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 60 * 1000;
/** 排程 job 失敗／超時後最多重試次數（每次相隔 1 小時），之後等下個排程。 */
const MAX_RETRIES = 3;

class JobTimeoutError extends Error {}

/** JOB_TIMEOUT_MS（毫秒；預設 10 分鐘）。注意：Promise.race 只係令排程唔再等；底層 job 無法強制中止。 */
function jobTimeoutMs(): number {
  const n = Number(process.env.JOB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_JOB_TIMEOUT_MS;
}

function errMessage(e: unknown): string {
  // 只存 message 前 500 字（job 內部錯誤訊息不含 PII：lib 層一向唔將姓名放入 Error）
  return (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LEN);
}

/** 確保每個 job 有設定行（已存在嘅 schedule／enabled 保留，唔覆蓋）；缺 next_run_at 補上。 */
export async function ensureJobRows(defs: JobDef[], now: Date = new Date()): Promise<void> {
  for (const def of defs) {
    const row = await prisma.scheduledJob.findUnique({ where: { jobKey: def.key } });
    if (!row) {
      await prisma.scheduledJob.createMany({ data: [{ jobKey: def.key, schedule: def.defaultSchedule, enabled: true, nextRunAt: nextRun(def.defaultSchedule, now) }], skipDuplicates: true });
    } else if (row.enabled && !row.nextRunAt && isValidCron(row.schedule)) {
      await prisma.scheduledJob.update({ where: { id: row.id }, data: { nextRunAt: nextRun(row.schedule, now) } });
    }
  }
}

/** 背景（非排程）job 嘅 stale 門檻比一般 job 短（S-batch-1021）：盤體系補推導 15 分鐘。 */
const SHORT_STALE_JOB_KEYS: Record<string, number> = { site_scheme_backfill: 15 * 60_000 };

/** 令機死／重啟留低嘅 running 紀錄（一般 >1 小時；site_scheme_backfill >15 分鐘）變 error，免得 /settings/jobs 永遠顯示「跑緊」。 */
export async function sweepStaleRuns(now: Date = new Date()): Promise<number> {
  const keys = Object.keys(SHORT_STALE_JOB_KEYS);
  const data = { status: "error" as const, finishedAt: now, summary: { error: "stale_running" } };
  let n = 0;
  for (const k of keys) n += (await prisma.jobRun.updateMany({ where: { status: "running", jobKey: k, startedAt: { lt: new Date(now.getTime() - SHORT_STALE_JOB_KEYS[k]!) } }, data })).count;
  n += (await prisma.jobRun.updateMany({ where: { status: "running", jobKey: { notIn: keys }, startedAt: { lt: new Date(now.getTime() - 3600_000) } }, data })).count;
  return n;
}

export async function runJob(def: JobDef | undefined, opts: { trigger: "schedule" | "manual"; now?: Date }): Promise<RunOutcome> {
  if (!def) return { outcome: "unknown_job" };
  const now = opts.now ?? new Date();
  const locked = await withJobLock(def.key, async (hold): Promise<RunOutcome> => {
    const row = await prisma.scheduledJob.findUnique({ where: { jobKey: def.key } });
    if (opts.trigger === "schedule") {
      // 認領：到期先 claim，同時推進 next_run_at（另一 instance 剛跑完就 count=0）
      if (!row || !row.enabled || !isValidCron(row.schedule)) return { outcome: "not_due" };
      const claim = await prisma.scheduledJob.updateMany({ where: { jobKey: def.key, enabled: true, nextRunAt: { lte: now } }, data: { nextRunAt: nextRun(row.schedule, now) } });
      if (claim.count === 0) return { outcome: "not_due" };
    }
    const run = await prisma.jobRun.create({ data: { jobKey: def.key, trigger: opts.trigger, status: "running", startedAt: new Date() } });
    let result: JobResult | null = null;
    let error: string | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let pendingJob: Promise<unknown> | undefined;
    try {
      const ms = jobTimeoutMs();
      const sysActor = await ensureSystemUser(); // 排程期間 actor 為 null 嘅 audit 補系統帳號，並帶 by_job
      const jobP = withAuditJob(def.key, () => def.run({ jobKey: def.key, trigger: opts.trigger, now }), sysActor);
      pendingJob = jobP;
      result = await Promise.race([
        jobP,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new JobTimeoutError(`超過最長執行時間 ${ms} ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } catch (e) {
      timedOut = e instanceof JobTimeoutError;
      if (timedOut) hold(pendingJob!); // 底層 job 未完：lock 持有到佢 settle 先釋放（防重複並發跑）
      error = errMessage(e);
      console.error(`[scheduler] job ${def.key} 失敗:`, e instanceof Error ? e.name : "error");
    }
    if (timer) clearTimeout(timer);
    const status: "ok" | "error" | "skipped" | "timeout" = timedOut ? "timeout" : error ? "error" : (result?.status ?? "ok");
    const summary = (error ? { error } : (result?.summary ?? {})) as Prisma.InputJsonValue;
    await prisma.jobRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), summary } });
    await prisma.scheduledJob.updateMany({ where: { jobKey: def.key }, data: { lastRunAt: new Date(), lastStatus: status, lastError: error ?? null } });
    if (error && opts.trigger === "schedule") {
      // 失敗／超時：1 小時後重試（連續失敗未超過 MAX_RETRIES 次；唔遲過原本下次排程時間）
      const recent = await prisma.jobRun.findMany({ where: { jobKey: def.key, trigger: "schedule", status: { not: "running" } }, orderBy: { startedAt: "desc" }, take: MAX_RETRIES + 1, select: { status: true } });
      let streak = 0;
      for (const x of recent) {
        if (x.status === "error" || x.status === "timeout") streak++;
        else break;
      }
      if (streak <= MAX_RETRIES) {
        const cur = await prisma.scheduledJob.findUnique({ where: { jobKey: def.key } });
        const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
        if (cur && cur.enabled && (!cur.nextRunAt || retryAt < cur.nextRunAt)) await prisma.scheduledJob.update({ where: { id: cur.id }, data: { nextRunAt: retryAt } });
      }
    }
    if (error) {
      // 失敗通知老闆（title／body 只有 job key 同 run id，唔含錯誤全文）
      await createNotification({ kind: "job_failed", title: timedOut ? "自動排程超時" : "自動排程出錯", body: `排程「${def.label}」（${def.key}）${timedOut ? "執行超時" : "執行失敗"}，詳情喺「自動排程」頁（run ${run.id}）。`, href: "/settings/jobs", audience: ["老闆"], dedupeKey: `job_failed:${run.id}` }).catch(() => undefined);
    }
    return { outcome: "ran", runId: run.id, status, summary: summary as Record<string, unknown>, ...(error ? { error } : {}) };
  });
  if (!locked.acquired) {
    if (opts.trigger === "manual") await prisma.jobRun.create({ data: { jobKey: def.key, trigger: "manual", status: "skipped", finishedAt: new Date(), summary: { reason: "locked" } } });
    return { outcome: "skipped_locked" };
  }
  return locked.value;
}

/** 一次 tick：跑晒所有到期 job（逐個，唔並行）。回傳跑咗幾多個。 */
export async function tick(defs: JobDef[], now: Date = new Date()): Promise<number> {
  await ensureJobRows(defs, now);
  await sweepStaleRuns(now);
  const due = await prisma.scheduledJob.findMany({ where: { enabled: true, nextRunAt: { lte: now }, jobKey: { in: defs.map((d) => d.key) } }, orderBy: { nextRunAt: "asc" } });
  let ran = 0;
  for (const row of due) {
    const r = await runJob(defs.find((d) => d.key === row.jobKey), { trigger: "schedule", now });
    if (r.outcome === "ran") ran++;
  }
  return ran;
}
