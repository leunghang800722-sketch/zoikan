// P14.2：`POST /api/longterm/inputs/drafts/generate?month=YYYY-MM`（老闆）——對指定**未鎖**月份即時跑
// `generateLongtermInputDrafts`＋`generateCoverDrafts`（同每日 job 一樣；actor＝系統帳號，咁「被人作廢嘅草稿唔再生成」判斷同 job 一致），
// 用同 job 一樣嘅 advisory lock 防並發（job／另一個請求跑緊 → 409）。鎖月 → 403。回 counts（唔含姓名）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ApiError, BadRequest, Forbidden } from "@/lib/api/errors";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { generateLongtermInputDrafts } from "@/lib/longterm-payroll/drafts";
import { generateCoverDrafts } from "@/lib/longterm-payroll/cover-drafts";
import { withJobLock } from "@/lib/scheduler/lock";
import { withAuditJob } from "@/lib/audit-job-context";
import { ensureSystemUser } from "@/lib/system-user";
import { writeAudit } from "@/lib/audit";
import { LONGTERM_INPUT_DRAFTS_KEY } from "@/lib/jobs/longterm-input-drafts";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    if (session.baseRole !== "老闆") throw Forbidden("只有老闆可以即時生成草稿");
    const raw = new URL(req.url).searchParams.get("month");
    const month = parseMonthParam(raw);
    if (!raw || !month) throw BadRequest("要帶 month=YYYY-MM");
    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: "drafts-generate", ip: getClientIp(req) });
    const sysId = await ensureSystemUser();
    const out = await withJobLock(LONGTERM_INPUT_DRAFTS_KEY, () =>
      withAuditJob(
        `${LONGTERM_INPUT_DRAFTS_KEY}:manual`,
        async () => {
          const draft = await generateLongtermInputDrafts(month, sysId);
          const cover = draft.locked ? null : await generateCoverDrafts(month, sysId);
          return { draft, cover };
        },
        sysId,
      ),
    );
    if (!out.acquired) throw new ApiError(409, "drafts_busy", "草稿生成緊（排程或另一個請求），請稍後再試");
    // 以 session 用戶做 actor 嘅 audit（誰撳咗生成）；草稿本身由系統帳號寫
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: `drafts-generate:${monthLabel(month)}`, action: "trigger_drafts_generate", after: { month: monthLabel(month), draft: out.value.draft, cover: out.value.cover }, ip: getClientIp(req) });
    return ok(brandSafeResponse({ month: monthLabel(month), draft: out.value.draft, cover: out.value.cover }));
  });
}
