// WP-PHASE3（§20.4 Phase 3 item 1）：PATCH 改一條長工崗位盤記錄——最常
// 用「終止」＝寫 `effective_to`（冇硬刪，同 `guard_staff_numbers`／
// `rate_cards` 一致「冇硬刪」精神，歷史記錄留低）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toGuardLongtermPostDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardLongtermPostUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden } from "@/lib/api/errors";
import { assertLongtermPostPeriodOk } from "@/lib/guards/longterm-posts";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; postId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以改長工崗位盤");
    const { id, postId } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();
    const before = await prisma.guardLongtermPost.findFirst({ where: { id: postId, guardId: id } });
    if (!before) throw NotFound("搵唔到呢條長工崗位盤記錄");

    const body = await readJson(req);
    const parsed = parseBody(GuardLongtermPostUpdateSchema, body);
    const data: Record<string, unknown> = {};
    if (parsed.effective_to !== undefined) data.effectiveTo = parsed.effective_to;
    if (parsed.note !== undefined) data.note = parsed.note;
    if (Object.keys(data).length === 0) return ok(toGuardLongtermPostDTO(before));
    // WP-PHASE3 Opus 5.5 驗收：終止日唔可以早過生效日（例如未來先生效嘅
    // 崗位喺今日撳「終止」）；延長／清空終止日唔可以同同盤另一條重疊。
    if (parsed.effective_to !== undefined && !before.voidedAt) {
      await assertLongtermPostPeriodOk({ guardId: id, siteId: before.siteId, effectiveFrom: before.effectiveFrom, effectiveTo: parsed.effective_to, excludePostId: postId });
    }

    const after = await prisma.guardLongtermPost.update({ where: { id: postId }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_posts", rowId: postId, action: "update", before, after, ip: getClientIp(req) });
    return ok(toGuardLongtermPostDTO(after));
  });
}
