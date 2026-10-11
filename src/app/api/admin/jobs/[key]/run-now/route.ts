// P7.1：`POST /api/admin/jobs/:key/run-now`——老闆手動立即跑一次（試跑用）。同排程用同一個 advisory lock，
// 撞正排程跑緊就回 409 job_busy。唔改 next_run_at。寫 audit。
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { Conflict, NotFound } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { findJob } from "@/lib/jobs/registry";
import { ensureJobRows, runJob } from "@/lib/scheduler/runner";
import { assertBossOnly } from "@/lib/jobs/admin";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    const { key } = await params;
    const def = findJob(key);
    if (!def) throw NotFound("搵唔到呢個排程");
    await ensureJobRows([def]);
    const r = await runJob(def, { trigger: "manual" });
    if (r.outcome === "skipped_locked") throw Conflict("呢個排程而家跑緊，等佢跑完再試");
    if (r.outcome !== "ran") throw NotFound("搵唔到呢個排程");
    await writeAudit({ actorUserId: session.userId, tableName: "scheduled_jobs", rowId: key, action: "job_run_now", after: { run_id: r.runId, status: r.status }, ip: getClientIp(req) });
    return ok(brandSafeResponse({ key, run_id: r.runId, status: r.status, summary: r.summary, error: r.error ?? null }));
  });
}
