// WP-ONE-CLICK Phase 1：`POST /api/month-close/one-click/:id/rerun`——
// 卡死（`running` 超過 15 分鐘）或者 `failed` 嘅 run 可以重新執行；
// job 本身逐步冪等（每步重跑安全），唔會累積重複動作。
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { NotFound, Conflict } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { runOneClickMonthClose, ONE_CLICK_ADVISORY_LOCK_KEY, ONE_CLICK_STALE_MS, monthCloseRunRerunAllowed } from "@/lib/month-close/one-click";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "一鍵結算", "update");
    const { id } = await params;
    const run = await prisma.monthCloseRun.findUnique({ where: { id } });
    if (!run) throw NotFound();
    if (!monthCloseRunRerunAllowed(run)) {
      throw Conflict(run.status === "running" ? "呢個 run 執行緊（未夠 15 分鐘），唔好重複撳——等佢完成" : `呢個 run 而家係 ${run.status}，冇需要重新執行`, { status: run.status });
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - ONE_CLICK_STALE_MS);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
      const other = await tx.monthCloseRun.findFirst({ where: { id: { not: id }, status: "running", applyStartedAt: { gt: staleBefore } }, select: { id: true } });
      if (other) throw Conflict("另一個一鍵結算執行緊，等佢完成先再撳", { status: "busy" });
      const claimed = await tx.monthCloseRun.updateMany({
        where: { id, OR: [{ status: "failed" }, { status: "running", applyStartedAt: { lt: staleBefore } }, { status: "running", applyStartedAt: null }] },
        data: { status: "running", applyStartedAt: now, finishedAt: null, errorMessage: null },
      });
      if (claimed.count === 0) throw Conflict("呢個 run 啱啱俾第二個請求攞咗", { status: "busy" });
    });

    await writeAudit({ actorUserId: session.userId, tableName: "month_close_runs", rowId: id, action: "update", after: { id, status: "running", rerun: true }, ip: getClientIp(req) });

    let backgrounded = true;
    try {
      after(() => runOneClickMonthClose(id, run.month, session.userId, getClientIp(req)));
    } catch {
      backgrounded = false;
    }
    if (!backgrounded) {
      await runOneClickMonthClose(id, run.month, session.userId, getClientIp(req));
      const finalRun = await prisma.monthCloseRun.findUnique({ where: { id } });
      return ok(brandSafeResponse({ runId: id, status: finalRun?.status ?? "failed" }), 200);
    }

    return ok(brandSafeResponse({ runId: id, status: "running" }), 202);
  });
}
