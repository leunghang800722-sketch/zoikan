// WP-LTSHIFT §19 交付 C：`POST /api/roster-uploads/reconcile-all
// { month }`——「重新對數全月」一鍵：順序 recomputeSettlement()→對數→
// 全部 roster_only/settlement_diff 用 apply_roster 套用（見
// `src/lib/roster-upload/reconcile-all.ts`）。可能要幾分鐘（成月幾十個
// 上載），同 guard-fix apply 一致做法：即刻 202 返、background 用
// Next `after()` 做，`reconcile_all_runs` 記錄狀態，頁面 poll `GET
// /api/roster-uploads/reconcile-all?month=` 攞最新一個 run。
//
// 權限：「更表上載」module 嘅 `update`（同 apply 對數決定一致），但
// 任務書明文淨係「老闆／會計」——主管雖然對「更表上載」有 update，都
// 額外顯式擋（同 referral-fee/recompute route 一致做法）。
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError, safeErrorSummary } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { BadRequest, Conflict, Forbidden } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { runReconcileAllForMonth, RECONCILE_ALL_ADVISORY_LOCK_KEY, RECONCILE_ALL_STALE_MS, reconcileAllApplyAllowed } from "@/lib/roster-upload/reconcile-all";

function safeError(e: unknown): string {
  const code = e instanceof Prisma.PrismaClientKnownRequestError ? `${e.code} ` : "";
  return `${code}${safeErrorSummary(e)}`.slice(0, 300);
}

async function performRun(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  try {
    const result = await runReconcileAllForMonth(month, actorUserId, ip);
    await prisma.reconcileAllRun.update({
      where: { id: runId },
      data: { status: "done", finishedAt: new Date(), resultJson: result as unknown as Prisma.InputJsonValue },
    });
    await writeAudit({
      actorUserId,
      tableName: "reconcile_all_runs",
      rowId: runId,
      action: "update",
      after: { id: runId, status: "done", uploadCount: result.uploadCount, applied: result.totals.applied, settlementChanged: result.totals.settlementChanged },
      ip: null,
    });
  } catch (e) {
    const message = safeError(e);
    console.error("[reconcile-all] 執行失敗：", message);
    try {
      await prisma.reconcileAllRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: message } });
      await writeAudit({ actorUserId, tableName: "reconcile_all_runs", rowId: runId, action: "update", after: { id: runId, status: "failed" }, ip: null });
    } catch (e2) {
      console.error("[reconcile-all] 標記 failed 都失敗：", safeError(e2));
    }
  }
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    if (session.baseRole !== "老闆" && session.baseRole !== "會計") {
      throw Forbidden("「重新對數全月」淨係老闆／會計可以做");
    }
    const body = (await readJson(req)) as { month?: unknown };
    const month = typeof body.month === "string" ? parseMonthParam(body.month) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");

    const now = new Date();
    const staleBefore = new Date(now.getTime() - RECONCILE_ALL_STALE_MS);
    const runId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${RECONCILE_ALL_ADVISORY_LOCK_KEY})`);
      const other = await tx.reconcileAllRun.findFirst({ where: { status: "running", startedAt: { gt: staleBefore } }, select: { id: true } });
      if (other) throw Conflict("另一個「重新對數全月」執行緊，等佢完成先再撳", { status: "busy" });
      const created = await tx.reconcileAllRun.create({ data: { month, status: "running", startedById: session.userId } });
      return created.id;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "reconcile_all_runs", rowId: runId, action: "create", after: { id: runId, month: month.toISOString().slice(0, 10), status: "running" }, ip: getClientIp(req) });

    let backgrounded = true;
    try {
      after(() => performRun(runId, month, session.userId, getClientIp(req)));
    } catch {
      backgrounded = false;
    }
    if (!backgrounded) {
      await performRun(runId, month, session.userId, getClientIp(req));
      const finalRun = await prisma.reconcileAllRun.findUnique({ where: { id: runId } });
      return ok(brandSafeResponse({ runId, status: finalRun?.status ?? "failed", result: finalRun?.resultJson ?? null }), 200);
    }

    return ok(brandSafeResponse({ runId, status: "running" }), 202);
  });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "更表上載", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    const runs = await prisma.reconcileAllRun.findMany({
      where: month ? { month } : undefined,
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return ok(
      brandSafeResponse({
        runs: runs.map((r) => ({
          id: r.id,
          month: r.month.toISOString().slice(0, 10),
          status: r.status,
          started_at: r.startedAt.toISOString(),
          finished_at: r.finishedAt?.toISOString() ?? null,
          apply_allowed: reconcileAllApplyAllowed(r),
          result: r.resultJson,
          error_message: r.errorMessage,
        })),
      }),
    );
  });
}
