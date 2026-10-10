// P3-5.3：多條 API route 重複定義嘅「按角色揀 RBAC module」resolver 抽共用。
// 純函數、行為同搬出前逐字一致；`requirePermission(req, <resolver>, action)` 照舊。
import { prisma } from "@/lib/db";
import { NotFound } from "@/lib/api/errors";
import { isBrokerRole, scopeGuardWhere } from "@/lib/broker-isolation";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";

/** 保安員資源：雞頭用「自己安員」（只見自己嘅人），內部角色用「安員」。 */
export function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

/** 盤／更別讀取：雞頭用「更表」（揀得到更表編輯器嘅盤），內部角色維持「盤」（盤管理，雞頭硬性 deny 唔變）。 */
export function siteReadModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "更表" : "盤";
}

/** 保安員子資源 route 共用前置：呢個保安員必須喺 session 可見範圍內（雞頭隔離），否則 404。 */
export async function assertScopedGuard(session: AuthedSession, guardId: string): Promise<void> {
  const guard = await prisma.guard.findFirst({ where: scopeGuardWhere(session, { id: guardId }), select: { id: true } });
  if (!guard) throw NotFound();
}
