// WP-GUARD-FIX-UI：`POST /api/guard-fix/plan { month }`——用現用 U Team
// 名單（最新一份 `status=parsed`）＋該月 active 上載計 plan（同
// `scripts/guard-fix/build-guard-fix-plan.ts` 一模一樣邏輯，見
// `src/lib/guard-fix/plan.ts`），存一行 `guard_fix_runs`（status=
// planned）。回 summary（冇 PII）＋ needs_boss 逐條（PII 受
// 「安員個人資料:view」gate，見 `src/lib/guard-fix/view.ts`）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { GuardFixPlanBodySchema } from "@/lib/api/schemas";
import { monthStart } from "@/lib/month-lock";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { buildGuardFixPlan, summarizePlan, NoActiveUploadsError } from "@/lib/guard-fix/plan";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import { buildNeedsBossView, APPLY_STALE_MS } from "@/lib/guard-fix/view";
import type { Prisma } from "@prisma/client";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "create");
    const body = parseBody(GuardFixPlanBodySchema, await req.json().catch(() => ({})));
    const month = monthStart(new Date(body.month));

    // Opus 5.5 驗收：套用緊（未卡死）嗰陣計劃會讀到一半嘅狀態——等佢完成。
    const busy = await prisma.guardFixRun.findFirst({ where: { status: "applying", applyStartedAt: { gt: new Date(Date.now() - APPLY_STALE_MS) } }, select: { id: true } });
    if (busy) throw Conflict("修復計劃套用緊，等佢完成先再計算", { status: "busy" });

    const staffList = await prisma.staffListUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" } });
    if (!staffList) throw BadRequest("未上載過 U Team 名單（或者最新一份解析失敗）——請先上載名單");

    let uTeamRows;
    try {
      uTeamRows = await parseUTeamWorkbookBuffer(Buffer.from(staffList.fileBytes));
    } catch {
      throw BadRequest("現用 U Team 名單解析唔到——請重新上載名單");
    }

    let plan;
    try {
      plan = await buildGuardFixPlan({ prisma, month, uTeamRows });
    } catch (e) {
      if (e instanceof NoActiveUploadsError) throw BadRequest(`${e.message}——呢個月未有更表上載，或者未解析成功`);
      throw e;
    }

    const summary = summarizePlan(plan);
    const summaryJson = { ...summary, hkidDroppedCount: plan.hkidDroppedCount } as unknown as Prisma.InputJsonValue;

    const run = await prisma.guardFixRun.create({
      data: {
        month,
        staffListUploadId: staffList.id,
        createdById: session.userId,
        planJson: plan as unknown as Prisma.InputJsonValue,
        summaryJson,
        status: "planned",
      },
    });

    const needsBoss = await buildNeedsBossView(prisma, session, plan);

    return ok(
      brandSafeResponse({
        runId: run.id,
        month: body.month,
        staffListUpload: { id: staffList.id, fileName: staffList.fileName, uploadedAt: staffList.uploadedAt.toISOString(), rowCount: staffList.rowCount },
        summary: { totalIdentities: summary.totalIdentities, totalCells: summary.totalCells, link: summary.link, create: summary.create, createMinimal: summary.createMinimal, needsBoss: summary.needsBoss, hkidDroppedCount: plan.hkidDroppedCount },
        needsBoss,
      }),
      201,
    );
  });
}
