// P7.1：`GET /api/admin/jobs`——排程 job 清單（開關、時間表、下次／上次結果、最近 5 次紀錄）。老闆專用。
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { JOBS } from "@/lib/jobs/registry";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { assertBossOnly } from "@/lib/jobs/admin";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    await ensureJobRows(JOBS); // 第一次開頁時（排程器未 tick 過）都有設定行
    const rows = await prisma.scheduledJob.findMany({ where: { jobKey: { in: JOBS.map((j) => j.key) } } });
    const runs = await prisma.jobRun.findMany({ where: { jobKey: { in: JOBS.map((j) => j.key) } }, orderBy: { startedAt: "desc" }, take: 60 });
    const jobs = JOBS.map((d) => {
      const r = rows.find((x) => x.jobKey === d.key);
      return {
        key: d.key,
        label: d.label,
        description: d.description,
        default_schedule: d.defaultSchedule,
        schedule: r?.schedule ?? d.defaultSchedule,
        enabled: r?.enabled ?? true,
        next_run_at: r?.nextRunAt ? r.nextRunAt.toISOString() : null,
        last_run_at: r?.lastRunAt ? r.lastRunAt.toISOString() : null,
        last_status: r?.lastStatus ?? null,
        last_error: r?.lastError ?? null,
        recent_runs: runs
          .filter((x) => x.jobKey === d.key)
          .slice(0, 5)
          .map((x) => ({ id: x.id, trigger: x.trigger, status: x.status, started_at: x.startedAt.toISOString(), finished_at: x.finishedAt ? x.finishedAt.toISOString() : null, summary: x.summary })),
      };
    });
    return ok(brandSafeResponse({ jobs }));
  });
}
