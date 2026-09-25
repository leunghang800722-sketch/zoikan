// WP-GUARD-FIX-UI：`POST /api/guard-fix/runs/:id/apply`——套用一個
// `planned` run（建人／登記工號／加別名，一個 transaction）＋自動逐個
// active 上載 `reparseRosterUpload()`。冪等：`status!=='planned'` 一律
// 409（同一 run 唔可以 apply 兩次）。
//
// 設計取捨（§18.9）：apply 可能要幾分鐘（建 70+ 位安員＋逐盤 reparse）——
// 呢度即刻將 status 轉 `applying`（快，喺 response 返之前完成，所以
// 「apply 咗未」呢個 409 判斷唔會撞 race），然後用 Next `after()` 喺
// response 送出之後先做重工夫，response 即刻 202 返 run id/status；
// 頁面 poll `GET /api/guard-fix/runs/:id` 直至 status 變
// `applied`/`failed`。如果 process 中途死咗（部署／重啟），run 會卡喺
// `applying`——冇自動復原機制（已知限制，見回報），要人手查 `guard_fix_
// runs` 表同 `roster_upload_rows` 現狀，然後老闆再嗌一次（`apply.ts`
// 嘅 transaction／reparse 本身都係冪等，卡住嗰刻可能已經寫咗一部
// 分，重新 apply 唔會重複建人，但 run 呢行本身唔會自動變返
// planned——要人手 UPDATE 或者直接開新 run）。
import { prisma } from "@/lib/db";
import { after } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { NotFound, Conflict } from "@/lib/api/errors";
import { applyGuardFixPlan, reparseAllActiveUploads } from "@/lib/guard-fix/apply";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import type { GuardFixPlan } from "@/lib/guard-fix/types";
import type { Prisma } from "@prisma/client";

async function performApply(runId: string, actorUserId: string): Promise<void> {
  const run = await prisma.guardFixRun.findUnique({ where: { id: runId } });
  if (!run) return; // 已經俾人刪咗（理論上唔會發生，冇 DELETE route）
  const plan = run.planJson as unknown as GuardFixPlan;
  try {
    const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, txTimeoutMs: 1_800_000 });
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
        totalBefore: reparse.totalBefore,
        totalAfter: reparse.totalAfter,
      },
      ip: null,
    });

    // apply 完成之後自動再計一次 plan（相當於 run-guard-fix.sh 嘅下一
    // 輪）——用返同一份 U Team 名單／同一個月，等老闆睇仲剩幾多。
    try {
      const staffList = await prisma.staffListUpload.findUnique({ where: { id: run.staffListUploadId } });
      if (staffList) {
        const uTeamRows = await parseUTeamWorkbookBuffer(Buffer.from(staffList.fileBytes));
        const nextPlan = await buildGuardFixPlan({ prisma, month: run.month, uTeamRows });
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
      // 下一輪 plan 計算失敗（例如冇 active 上載剩低）唔應該令呢個 run
      // 本身變 failed——本身已經 applied 成功，淨係冇自動開到下一輪。
      console.error("[guard-fix apply] 自動計下一輪 plan 失敗（唔影響本身 apply 結果）：", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.guardFixRun.update({ where: { id: runId }, data: { status: "failed", resultJson: { error: message.slice(0, 500) } as unknown as Prisma.InputJsonValue } });
    await writeAudit({ actorUserId, tableName: "guard_fix_runs", rowId: runId, action: "update", after: { id: runId, status: "failed" }, ip: null });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "update");
    const { id } = await params;
    const run = await prisma.guardFixRun.findUnique({ where: { id } });
    if (!run) throw NotFound();
    if (run.status !== "planned") {
      throw Conflict(`呢個 run 而家係 ${run.status}，唔可以再 apply（planned 先可以）`, { status: run.status });
    }

    // 即刻轉 applying——同一 run 兩個請求撞埋，第二個會喺呢度見到
    // status!=='planned' 拎 409（`update` 係原子操作，冇 race window
    // 俾兩邊都通過檢查）。
    const claimed = await prisma.guardFixRun.updateMany({ where: { id, status: "planned" }, data: { status: "applying" } });
    if (claimed.count === 0) {
      throw Conflict("呢個 run 啱啱俾第二個請求攞咗，唔可以再 apply", { status: "applying" });
    }

    // `after()` 淨係喺真正 Next request 生命週期入面得（`workAsyncStorage`
    // 有 store）——`npx next start`／`next dev` 經正常 HTTP 進嚟先有；測試
    // 直接call呢個 route handler function（同呢個 codebase 全部 integration
    // test 一致做法，唔起真 HTTP server）冇呢個 context，call 咗會即刻
    // throw「after() was called outside a request scope」。
    // 呢度 try/catch 一次—— 有 context（正式運作）就背景做、即刻 202 返；
    // 冇 context（測試／或者將來改用嘅任何非標準 runtime）就 fallback
    // 同步做晒先返，response 帶返實際完成咗嘅 status，行為一致唔會
    // 「話自己 applying 但其實冧咗」。
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
