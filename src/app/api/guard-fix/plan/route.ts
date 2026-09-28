// WP-GUARD-FIX-UI：`POST /api/guard-fix/plan { month }`——用現用 U Team
// 名單（最新一份 `status=parsed`）＋該月 active 上載計 plan（同
// 舊 `scripts/guard-fix/build-guard-fix-plan.ts`（script 已於 2026-09-28 效能優化刪除，功能由一鍵結算 stepGuardFix／正式站 API 取代） 一模一樣邏輯，見
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
import { parsePostorderUploadRow } from "@/lib/guard-fix/postorder";
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

    // WP-LTSHIFT §19：呢個月現用 Postorder 上載（冇上載都照計，set_longterm
    // 等四類新 action 一律 0 項，唔影響原有 link/create 行為）。
    const postorderUpload = await prisma.postorderUpload.findFirst({ where: { month, status: "parsed" }, orderBy: { uploadedAt: "desc" } });
    // WP-POSTORDER-CSV：xlsm 定 CSV 上載都用呢個統一入口（見 postorder.ts
    // `parsePostorderUploadRow()`），揸 fileBytes 定 rosterCsvBytes/
    // postorderCsvBytes 由裡面判斷，呢度唔使分兩套邏輯。
    const postorder = postorderUpload ? { uploadId: postorderUpload.id, fileName: postorderUpload.fileName, ...(await parsePostorderUploadRow(postorderUpload)) } : undefined;

    let plan;
    try {
      plan = await buildGuardFixPlan({ prisma, month, uTeamRows, postorder });
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
        postorderUploadId: postorderUpload?.id ?? null,
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
        postorderUpload: postorderUpload ? { id: postorderUpload.id, fileName: postorderUpload.fileName, uploadedAt: postorderUpload.uploadedAt.toISOString() } : null,
        summary: {
          totalIdentities: summary.totalIdentities,
          totalCells: summary.totalCells,
          link: summary.link,
          create: summary.create,
          createMinimal: summary.createMinimal,
          needsBoss: summary.needsBoss,
          setLongterm: summary.setLongterm,
          setLongtermPost: summary.setLongtermPost,
          setReferral: summary.setReferral,
          setReferralInferred: summary.setReferralInferred,
          setVisa: summary.setVisa,
          hkidDroppedCount: plan.hkidDroppedCount,
        },
        postorder: plan.postorder,
        needsBoss,
      }),
      201,
    );
  });
}
