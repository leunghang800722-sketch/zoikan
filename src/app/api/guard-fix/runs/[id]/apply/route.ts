// WP-GUARD-FIX-UI：`POST /api/guard-fix/runs/:id/apply`——套用一個 run
// （建人／登記工號／加別名，一個 transaction）＋自動逐個 active 上載
// `reparseRosterUpload()`＋自動計下一輪 plan。
//
// 設計取捨（§18.9）：apply 可能要幾分鐘（建 70+ 位保安員＋逐盤 reparse）——
// 呢度即刻將 status 轉 `applying`（快，喺 response 返之前完成），然後用
// Next `after()` 喺 response 送出之後先做重工夫，response 即刻 202 返；
// 頁面 poll `GET /api/guard-fix/runs/:id` 直至 `applied`/`failed`。唔靠長
// request（Zeabur 反向代理 timeout 唔知）。
//
// Opus 5.5 驗收修正：
//  - 可以套用嘅狀態：`planned`；`failed`（重試）；`applying` 但
//    `apply_started_at` 超過 15 分鐘（server 中途重啟／部署令背景工作冇
//    咗——卡死復原）。其餘（`applied`、未過 15 分鐘嘅 `applying`）409。
//    apply 本身冪等（U 號／身份證／同名同電話已存在就跳過；reparse 冪等），
//    所以重試安全。
//  - 認領（→applying）喺 `pg_advisory_xact_lock` 入面做，同時檢查冇第二
//    個「未卡死」嘅 run 喺度 applying——兩個 run 同時套用 409；
//    `applyGuardFixPlan()` transaction 入面仲有同一把 lock（script 同頁面
//    同時行都會排隊）。
//  - 錯誤訊息：Prisma「Invalid invocation」會連 create 參數（姓名／電話／
//    身份證）成段帶出——`result_json.error`／server log 一律淨係存
//    `safeErrorSummary()`（錯誤類別＋最後一行診斷），唔存 payload。
import { prisma } from "@/lib/db";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError, getClientIp, safeErrorSummary } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { NotFound, Conflict } from "@/lib/api/errors";
import { applyGuardFixPlan, reparseAllActiveUploads, GUARD_FIX_ADVISORY_LOCK_KEY } from "@/lib/guard-fix/apply";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import { parsePostorderUploadRow } from "@/lib/guard-fix/postorder";
import { APPLY_STALE_MS, applyAllowed } from "@/lib/guard-fix/view";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

function safeError(e: unknown): string {
  const code = e instanceof Prisma.PrismaClientKnownRequestError ? `${e.code} ` : "";
  return `${code}${safeErrorSummary(e)}`.slice(0, 300);
}

async function performApply(runId: string, actorUserId: string): Promise<void> {
  const run = await prisma.guardFixRun.findUnique({ where: { id: runId } });
  if (!run) return; // 冇 DELETE route，理論上唔會發生
  const plan = run.planJson as unknown as GuardFixPlan;
  try {
    const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, txTimeoutMs: 1_800_000, month: run.month });
    const reparse = await reparseAllActiveUploads(prisma, run.month, { txTimeoutMs: 600_000 });
    const resultJson = { diffs, reparse } as unknown as Prisma.InputJsonValue;

    await prisma.guardFixRun.update({ where: { id: runId }, data: { status: "applied", appliedAt: new Date(), resultJson } });
    await writeAudit({
      actorUserId,
      tableName: "guard_fix_runs",
      rowId: runId,
      action: "update",
      after: {
        id: runId,
        status: "applied",
        linkProcessed: diffs.link.create.length,
        createProcessed: diffs.create.create.length,
        createMinimalProcessed: diffs.createMinimal.create.length,
        setLongtermProcessed: diffs.setLongterm.create.length,
        setLongtermPostProcessed: diffs.setLongtermPost.create.length,
        setReferralProcessed: diffs.setReferral.create.length,
        setReferralInferredProcessed: diffs.setReferralInferred.create.length,
        setVisaProcessed: diffs.setVisa.create.length,
        totalBefore: reparse.totalBefore,
        totalAfter: reparse.totalAfter,
      },
      ip: null,
    });

    // apply 完成之後自動再計一次 plan（相當於已刪嘅 run-guard-fix.sh 嘅下一
    // 輪）——用返同一份 U Team 名單／同一個月，等老闆睇仲剩幾多。
    try {
      const staffList = await prisma.staffListUpload.findUnique({ where: { id: run.staffListUploadId } });
      if (staffList) {
        const uTeamRows = await parseUTeamWorkbookBuffer(Buffer.from(staffList.fileBytes));
        const postorderUpload = run.postorderUploadId ? await prisma.postorderUpload.findUnique({ where: { id: run.postorderUploadId } }) : null;
        // WP-POSTORDER-CSV：統一入口，xlsm/CSV 上載都得——見 plan/route.ts 同款註解。
        const postorder = postorderUpload ? { uploadId: postorderUpload.id, fileName: postorderUpload.fileName, ...(await parsePostorderUploadRow(postorderUpload)) } : undefined;
        const nextPlan = await buildGuardFixPlan({ prisma, month: run.month, uTeamRows, postorder });
        const nextSummary = summarizePlan(nextPlan);
        await prisma.guardFixRun.create({
          data: {
            month: run.month,
            staffListUploadId: staffList.id,
            createdById: actorUserId,
            planJson: nextPlan as unknown as Prisma.InputJsonValue,
            summaryJson: { ...nextSummary, hkidDroppedCount: nextPlan.hkidDroppedCount } as unknown as Prisma.InputJsonValue,
            status: "planned",
          },
        });
      }
    } catch (e) {
      // 下一輪 plan 計算失敗唔影響本身 apply 結果（已經 applied）。
      console.error("[guard-fix apply] 自動計下一輪 plan 失敗（唔影響本身 apply 結果）：", safeError(e));
    }
  } catch (e) {
    const message = safeError(e);
    console.error("[guard-fix apply] 套用失敗：", message);
    try {
      await prisma.guardFixRun.update({ where: { id: runId }, data: { status: "failed", resultJson: { error: message } as unknown as Prisma.InputJsonValue } });
      await writeAudit({ actorUserId, tableName: "guard_fix_runs", rowId: runId, action: "update", after: { id: runId, status: "failed" }, ip: null });
    } catch (e2) {
      // DB 都寫唔到（例如連線斷咗）——run 會留喺 applying，15 分鐘後頁面
      // 可以「重新套用」。
      console.error("[guard-fix apply] 標記 failed 都失敗：", safeError(e2));
    }
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "update");
    const { id } = await params;
    const run = await prisma.guardFixRun.findUnique({ where: { id }, select: { id: true, status: true, applyStartedAt: true } });
    if (!run) throw NotFound();
    if (!applyAllowed(run)) {
      throw Conflict(
        run.status === "applying" ? "呢個 run 套用緊（未夠 15 分鐘），唔好重複撳——等佢完成" : `呢個 run 而家係 ${run.status}，唔可以再套用（要再修就重新計算修復計劃）`,
        { status: run.status },
      );
    }

    // 認領：advisory lock 入面檢查「冇第二個未卡死嘅 run 套用緊」＋條件式
    // updateMany（狀態喺檢查同寫入之間俾人改咗就 count=0 → 409）。
    const now = new Date();
    const staleBefore = new Date(now.getTime() - APPLY_STALE_MS);
    const previousStatus = run.status;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${GUARD_FIX_ADVISORY_LOCK_KEY})`);
      const other = await tx.guardFixRun.findFirst({ where: { id: { not: id }, status: "applying", applyStartedAt: { gt: staleBefore } }, select: { id: true } });
      if (other) throw Conflict("另一個修復計劃套用緊，等佢完成先再撳", { status: "busy" });
      const claimed = await tx.guardFixRun.updateMany({
        where: {
          id,
          OR: [{ status: "planned" }, { status: "failed" }, { status: "applying", OR: [{ applyStartedAt: null }, { applyStartedAt: { lt: staleBefore } }] }],
        },
        data: { status: "applying", applyStartedAt: now, resultJson: Prisma.DbNull },
      });
      if (claimed.count === 0) throw Conflict("呢個 run 啱啱俾第二個請求攞咗，唔可以再套用", { status: "applying" });
    });
    if (previousStatus !== "planned") {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_fix_runs", rowId: id, action: "update", after: { id, status: "applying", retryFrom: previousStatus }, ip: getClientIp(req) });
    }

    // `after()` 淨係喺真正 Next request 生命週期入面得——測試直接 call
    // route handler function 冇呢個 context，會 throw；fallback 同步做晒先
    // 返，response 帶實際完成嘅 status。
    let backgrounded = true;
    try {
      after(() => performApply(id, session.userId));
    } catch {
      backgrounded = false;
    }
    if (!backgrounded) {
      await performApply(id, session.userId);
      const finalRun = await prisma.guardFixRun.findUnique({ where: { id }, select: { status: true } });
      return ok(brandSafeResponse({ runId: id, status: finalRun?.status ?? "failed" }), 200);
    }

    return ok(brandSafeResponse({ runId: id, status: "applying" }), 202);
  });
}
