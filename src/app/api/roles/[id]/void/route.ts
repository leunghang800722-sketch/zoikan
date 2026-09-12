// 淨係 is_custom=true 嘅角色（複製出嚟嘅）先可以 void；五個出廠角色
// （老闆/主管/會計/雞頭/安員）唔准 void——唔係硬性規則 module/action 格，
// 而係實體層面嘅保護（冇咗出廠角色，成個 RBAC seed 假設就散晒）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toRoleDTO } from "@/lib/api/dto";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { Forbidden } from "@/lib/api/errors";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.role.findUniqueOrThrow({ where: { id } });
    if (!before.isCustom) throw Forbidden("五個出廠角色唔可以作廢");
    const after = await prisma.role.update({ where: { id }, data: { voidedAt: new Date(), voidedBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "roles", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(toRoleDTO(after));
  });
}
