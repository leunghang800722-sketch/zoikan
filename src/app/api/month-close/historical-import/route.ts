// HIST-2：歷史月份（month_closes.historical=true）一鍵導入。
// `POST /api/month-close/historical-import { month }`——開一個新 run，即刻 202 返，背景用 Next `after()` 跑
// （同一鍵結算一致：advisory lock 認領、15 分鐘卡死復原——卡死 run 唔擋新 run）。
// `GET /api/month-close/historical-import?month=`——run 歷史（含 steps／report，最多 10 個，最新先）。
// 權限同一鍵結算（「一鍵結算」module：create／view）。非歷史月份 409 `not_historical_month`。
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { claimHistoricalImportRun, runHistoricalImport, histImportRunStalled } from "@/lib/month-close/historical-import";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "一鍵結算", "create");
    const body = (await readJson(req)) as { month?: unknown };
    const month = typeof body.month === "string" ? parseMonthParam(body.month) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");

    const runId = await claimHistoricalImportRun(month, session.userId);
    await writeAudit({ actorUserId: session.userId, tableName: "historical_import_runs", rowId: runId, action: "create", after: { id: runId, month: month.toISOString().slice(0, 10), status: "running" }, ip: getClientIp(req) });

    let backgrounded = true;
    try {
      after(() => runHistoricalImport(runId, month, session.userId, getClientIp(req)));
    } catch {
      backgrounded = false;
    }
    if (!backgrounded) {
      await runHistoricalImport(runId, month, session.userId, getClientIp(req));
      const finalRun = await prisma.historicalImportRun.findUnique({ where: { id: runId } });
      return ok(brandSafeResponse({ runId, status: finalRun?.status ?? "failed", stepsJson: finalRun?.stepsJson ?? [], reportJson: finalRun?.reportJson ?? null }), 200);
    }
    return ok(brandSafeResponse({ runId, status: "running" }), 202);
  });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "一鍵結算", "view");
    const monthParam = new URL(req.url).searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    const runs = await prisma.historicalImportRun.findMany({ where: month ? { month } : undefined, orderBy: { startedAt: "desc" }, take: 10 });
    return ok(
      brandSafeResponse({
        runs: runs.map((r) => ({
          id: r.id,
          month: r.month.toISOString().slice(0, 10),
          status: r.status,
          started_at: r.startedAt.toISOString(),
          finished_at: r.finishedAt?.toISOString() ?? null,
          current_step: r.currentStep,
          stalled: histImportRunStalled(r),
          steps: r.stepsJson,
          report: r.reportJson,
          error_message: r.errorMessage,
        })),
      }),
    );
  });
}
