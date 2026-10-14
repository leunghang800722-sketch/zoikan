// P17：`POST /api/longterm/inputs/:id/sl-decision`——病假草稿逐段人手決定（老闆 2026-10-14：有 SL 一定要人手確認先出津貼）。
// body：{ decision: "confirm" | "unpaid", reason?: string }
//   confirm＝有醫生紙：醫生紙標已核實＋草稿轉 confirmed（計糧，按累積結餘出 4/5）；
//   unpaid ＝冇醫生紙：作廢草稿並記原因（同一組日期之後唔再生成）→ 當無薪假。
// 鎖月 → 403；唔係待確認嘅病假草稿 → 409；同已確認病假段重疊 → 409。權限：長工糧 update。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { prisma } from "@/lib/db";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { ApiError, BadRequest, NotFound } from "@/lib/api/errors";
import { toLongtermInputDTO } from "@/lib/longterm-payroll/dto";
import { decideSlDraft, SlDecisionError } from "@/lib/longterm-payroll/sl-confirm";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { id } = await params;
    const body = await readJson(req);
    const decision = body.decision;
    if (decision !== "confirm" && decision !== "unpaid") throw BadRequest('decision 只可以係 "confirm" 或 "unpaid"');
    const reason = typeof body.reason === "string" ? body.reason : null;
    const row = await prisma.longtermPayrollInput.findUnique({ where: { id }, select: { month: true } });
    if (!row) throw NotFound();
    const ip = getClientIp(req);
    await assertMonthNotLocked({ workDate: row.month, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, ip });
    try {
      const after = await decideSlDraft(id, decision, reason, session.userId, ip);
      return ok(brandSafeResponse({ input: toLongtermInputDTO(after), decision }));
    } catch (e) {
      if (e instanceof SlDecisionError) {
        if (e.code === "not_found") throw NotFound();
        throw new ApiError(409, e.code === "overlap" ? "overlaps_confirmed_leave" : "not_sl_draft", e.message);
      }
      throw e;
    }
  });
}
