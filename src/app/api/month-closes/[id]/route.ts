import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toMonthCloseDTO } from "@/lib/api/dto";
import { toBrokerMonthCloseDTO } from "@/lib/broker-dto";
import { isBrokerRole } from "@/lib/broker-isolation";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { NotFound, Forbidden, BadRequest } from "@/lib/api/errors";
import { readJson } from "@/lib/api/query";
import { unmarkHistoricalMonth } from "@/lib/month-close/historical";

// [id] = month_closes.id（uuid）
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 規劃裁定（Opus 對抗式驗收第三輪，應修）：同 route.ts 嘅 GET 一致
    // 改用「更表:view」——理由見嗰邊註解。
    const session = await requirePermission(req, "更表", "view");
    const { id } = await params;
    const row = await prisma.monthClose.findUnique({ where: { id } });
    if (!row) throw NotFound();
    // C1（Opus 對抗式驗收第四輪）：雞頭淨係見 { id, month, locked_at }。
    if (isBrokerRole(session)) {
      return ok(toBrokerMonthCloseDTO(row));
    }
    return ok(await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(row)));
  });
}

// HIST-1.1：PATCH { historical: false } 取消歷史月份標記（老闆專用，寫 audit）。標記經 POST /api/month-closes { historical:true }。
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結鎖定解鎖", "void");
    if (session.baseRole !== "老闆") throw Forbidden("取消歷史月份淨係老闆先可以用");
    const { id } = await params;
    const body = await readJson(req);
    if (body.historical !== false || Object.keys(body).length !== 1) throw BadRequest("只接受 { historical: false }（取消歷史月份標記）");
    const row = await unmarkHistoricalMonth(id, session.userId, getClientIp(req));
    return ok(await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(row)));
  });
}
