import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toGuardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 雞頭角色喺 matrix.ts 「安員:void」係硬性 deny（限自己安員都唔包括
    // void），所以呢度冇再額外做 broker scope——requirePermission 已經
    // 喺雞頭 role 嗰陣拋 403。
    const session = await requirePermission(req, "安員", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.guard.findUniqueOrThrow({ where: { id } });
    const after = await prisma.guard.update({ where: { id }, data: { status: "inactive" } });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(after)));
  });
}
