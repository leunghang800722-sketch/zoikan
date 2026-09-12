import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toMonthCloseDTO } from "@/lib/api/dto";
import { toBrokerMonthCloseDTO } from "@/lib/broker-dto";
import { isBrokerRole } from "@/lib/broker-isolation";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, withApiError } from "@/lib/api/http";
import { NotFound } from "@/lib/api/errors";

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
