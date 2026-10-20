// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：
// `POST /api/month-close/one-click { month }`——開一個新 run，即刻 202
// 返，背景用 Next `after()` 跑（同 guard-fix apply／reconcile-all 一致
// pattern：advisory lock 認領＋15 分鐘卡死復原）。
// `GET /api/month-close/one-click?month=`——run 歷史。P3-1.6：預設只回摘要欄（唔帶 steps／report，
// 列表由 ~160 KB 降到幾 KB）；`?include=full` 先帶全份 steps／report（同舊版一模一樣）；
// 單一 run 全份用 `GET /api/month-close/one-click/:id`。
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { findOneClickRuns, findOneClickRunSummaries, oneClickRunToDTO, oneClickRunSummaryToDTO } from "@/lib/month-close/one-click-read";
import { assertNotHistoricalMonth } from "@/lib/month-close/historical";
import { runOneClickMonthClose, ONE_CLICK_ADVISORY_LOCK_KEY, ONE_CLICK_STALE_MS } from "@/lib/month-close/one-click";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "一鍵結算", "create");
    const body = (await readJson(req)) as { month?: unknown };
    const month = typeof body.month === "string" ? parseMonthParam(body.month) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");
    await assertNotHistoricalMonth(month, "一鍵結算"); // HIST-1

    const now = new Date();
    const staleBefore = new Date(now.getTime() - ONE_CLICK_STALE_MS);
    const runId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
      const other = await tx.monthCloseRun.findFirst({ where: { status: "running", applyStartedAt: { gt: staleBefore } }, select: { id: true } });
      if (other) throw Conflict("另一個一鍵結算執行緊，等佢完成先再撳", { status: "busy" });
      const created = await tx.monthCloseRun.create({ data: { month, status: "running", startedById: session.userId, applyStartedAt: now } });
      return created.id;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "month_close_runs", rowId: runId, action: "create", after: { id: runId, month: month.toISOString().slice(0, 10), status: "running" }, ip: getClientIp(req) });

    let backgrounded = true;
    try {
      after(() => runOneClickMonthClose(runId, month, session.userId, getClientIp(req)));
    } catch {
      backgrounded = false;
    }
    if (!backgrounded) {
      await runOneClickMonthClose(runId, month, session.userId, getClientIp(req));
      const finalRun = await prisma.monthCloseRun.findUnique({ where: { id: runId } });
      return ok(brandSafeResponse({ runId, status: finalRun?.status ?? "failed", stepsJson: finalRun?.stepsJson ?? [], reportJson: finalRun?.reportJson ?? null }), 200);
    }

    return ok(brandSafeResponse({ runId, status: "running" }), 202);
  });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "一鍵結算", "view");
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    const full = url.searchParams.get("include") === "full";
    // P3-1.6：預設列表唔讀 steps_json／report_json（兩欄係大 JSON），只讀摘要要用嘅欄；
    // totals／steps 完成數由 DB 側 jsonb 運算攞，唔經 Node 解析整份報告。
    if (full) {
      const runs = await findOneClickRuns(month);
      return ok(brandSafeResponse({ runs: runs.map(oneClickRunToDTO) }));
    }
    const runs = await findOneClickRunSummaries(month);
    return ok(brandSafeResponse({ runs: runs.map(oneClickRunSummaryToDTO) }));
  });
}
