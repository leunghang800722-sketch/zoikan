// SITE-SCHEME-1.1：盤體系補推導／重推導改背景執行。
// 做法（揀最簡單可靠）：同步部分（寫 staff_scheme）喺 request 內完成；歸屬補推導用 Next `after()` 喺 response 之後行，進度／結果記喺現有 `job_runs`
// （jobKey `site_scheme_backfill`，trigger manual，summary 淨計數）；caller 回 202＋job_id，頁面輪詢 `GET …/staff-scheme-prefill?job=<id>`。
// 冇 Next request context（vitest 直接 call route）→ `after()` 會 throw，fallback 同步行完再返（status 已經係 ok）。
// 卡死復原：scheduler runner `sweepStaleRuns`——一般 job running 超過 1 小時、`site_scheme_backfill` 超過 15 分鐘 → error stale_running；UI 輪詢 10 分鐘仍 running 顯示「可能已中斷，可重新套用」。
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { backfillSiteStaffNumbers, reinferSiteStaffNumbers } from "@/lib/shift-records/backfill-site-staff-numbers";

const SITE_SCHEME_JOB_KEY = "site_scheme_backfill";

type JobSpec = { mode: "backfill"; siteIds: string[] } | { mode: "reinfer"; siteId: string };

/** job 失敗 summary：唔含 PII——error_code＝err.name；message＝err.name＋前 120 字，數字串一律換 #（電話／證件號／金額唔留）。 */
export function errorSummary(e: unknown): Prisma.InputJsonValue {
  const name = e instanceof Error && e.name ? e.name : "error";
  const msg = e instanceof Error ? e.message : "";
  return { error: name, error_code: name, message: `${name}: ${msg}`.slice(0, 120).replace(/\d+/g, "#") };
}

async function runJob(jobId: string, spec: JobSpec, actorUserId: string | null): Promise<void> {
  try {
    if (spec.mode === "backfill") {
      const r = await backfillSiteStaffNumbers(spec.siteIds);
      await prisma.jobRun.update({ where: { id: jobId }, data: { status: "ok", finishedAt: new Date(), summary: { mode: "backfill", sites: spec.siteIds.length, ...r } as Prisma.InputJsonValue } });
    } else {
      const r = await reinferSiteStaffNumbers(spec.siteId);
      await writeAudit({ actorUserId, tableName: "sites", rowId: spec.siteId, action: "site_staff_scheme_reinfer", after: { cleared: r.cleared, backfilled: r.backfilled, unresolved: r.unresolved, locked_kept: r.locked_kept }, ip: null });
      await prisma.jobRun.update({ where: { id: jobId }, data: { status: "ok", finishedAt: new Date(), summary: { mode: "reinfer", sites: 1, ...r } as Prisma.InputJsonValue } });
    }
  } catch (e) {
    await prisma.jobRun.update({ where: { id: jobId }, data: { status: "error", finishedAt: new Date(), summary: errorSummary(e) } });
  }
}

/** 開 job 並背景執行；回 job id 同「係咪已經同步行完」。 */
export async function startSiteSchemeJob(spec: JobSpec, actorUserId: string | null): Promise<{ jobId: string; finished: boolean }> {
  const run = await prisma.jobRun.create({ data: { jobKey: SITE_SCHEME_JOB_KEY, trigger: "manual", status: "running", summary: { mode: spec.mode } } });
  let backgrounded = true;
  try {
    after(() => runJob(run.id, spec, actorUserId));
  } catch {
    backgrounded = false;
  }
  if (!backgrounded) await runJob(run.id, spec, actorUserId);
  return { jobId: run.id, finished: !backgrounded };
}

export async function getSiteSchemeJob(id: string): Promise<{ id: string; status: string; summary: unknown } | null> {
  const r = await prisma.jobRun.findFirst({ where: { id, jobKey: SITE_SCHEME_JOB_KEY }, select: { id: true, status: true, summary: true } });
  return r;
}
