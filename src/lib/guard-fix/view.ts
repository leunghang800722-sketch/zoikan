// WP-GUARD-FIX-UI：`GuardFixRun.planJson`（帶 PII）→ 俾頁面睇嘅
// needs_boss 逐條 view——`POST /api/guard-fix/plan`／`GET /api/guard-fix/
// runs/:id` 共用。老闆見到姓名／工號／候選描述，但仲要多一重
// 「安員個人資料:view」（同 GUARD_PII_FIELDS 一致嘅資源，見
// src/lib/api/field-groups.ts）先俾姓名/工號/電話/候選姓名出街——`安員
// 配對修復` module 本身已經淨係老闆，但保留呢層 defense-in-depth（同
// 「安員個人資料」PII field group 一致嘅 gate 邏輯），等老闆將呢個
// module 開俾第二個角色都唔會意外漏 PII。
import type { PrismaClient } from "@prisma/client";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { hasPermission } from "@/lib/rbac/requirePermission";
import type { GuardFixPlan, GuardFixCellRef } from "@/lib/guard-fix/types";

export interface GuardFixNeedsBossView {
  seq: string;
  cells: GuardFixCellRef[];
  totalCellCount: number;
  reason: string;
  nameRaw?: string;
  staffNoRaw?: string | null;
  telRaw?: string | null;
  candidates?: Array<{ id: string; nameZh: string }>;
}

export async function buildNeedsBossView(prisma: PrismaClient, session: AuthedSession, plan: GuardFixPlan): Promise<GuardFixNeedsBossView[]> {
  const canViewPii = await hasPermission(session, "安員個人資料", "view");
  const candidateIds = [...new Set(plan.actions.needsBoss.flatMap((a) => a.candidateGuardIds))];
  const guardsById = canViewPii && candidateIds.length ? new Map((await prisma.guard.findMany({ where: { id: { in: candidateIds } }, select: { id: true, nameZh: true } })).map((g) => [g.id, g.nameZh])) : new Map<string, string>();

  return plan.actions.needsBoss.map((a) => {
    const identity = plan.identities.find((i) => i.seq === a.seq)!;
    const base: GuardFixNeedsBossView = { seq: a.seq, cells: identity.cells, totalCellCount: identity.totalCellCount, reason: a.reason };
    if (!canViewPii) return base;
    return {
      ...base,
      nameRaw: identity.nameRaw,
      staffNoRaw: identity.staffNoRaw,
      telRaw: identity.telRaw,
      candidates: a.candidateGuardIds.map((id) => ({ id, nameZh: guardsById.get(id) ?? "（搵唔到）" })),
    };
  });
}
