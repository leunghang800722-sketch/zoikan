// P7.1：`PATCH /api/admin/jobs/:key`——改開關／時間表（5 欄 cron，香港時間）。老闆專用，寫 audit。
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { JobUpdateSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { findJob } from "@/lib/jobs/registry";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { assertBossOnly } from "@/lib/jobs/admin";
import { isValidCron, nextRun } from "@/lib/scheduler/cron";

export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    const { key } = await params;
    const def = findJob(key);
    if (!def) throw NotFound("搵唔到呢個排程");
    const input = parseBody(JobUpdateSchema, await readJson(req));
    if (input.schedule !== undefined && !isValidCron(input.schedule)) throw BadRequest("時間表唔啱：要 5 欄 cron（分 時 日 月 星期，香港時間），例如「0 9 25 * *」");
    await ensureJobRows([def]);
    const before = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: key } });
    const schedule = input.schedule ?? before.schedule;
    const enabled = input.enabled ?? before.enabled;
    const after = await prisma.scheduledJob.update({
      where: { jobKey: key },
      data: { schedule, enabled, nextRunAt: enabled ? nextRun(schedule, new Date()) : null },
    });
    await writeAudit({ actorUserId: session.userId, tableName: "scheduled_jobs", rowId: key, action: "update", before: { schedule: before.schedule, enabled: before.enabled }, after: { schedule: after.schedule, enabled: after.enabled }, ip: getClientIp(req) });
    return ok(brandSafeResponse({ key, schedule: after.schedule, enabled: after.enabled, next_run_at: after.nextRunAt ? after.nextRunAt.toISOString() : null }));
  });
}
