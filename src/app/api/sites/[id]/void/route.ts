import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { toSiteDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.site.findUniqueOrThrow({ where: { id } });
    const after = await prisma.site.update({ where: { id }, data: { status: "ended" } });
    await writeAudit({ actorUserId: session.userId, tableName: "sites", rowId: id, action: "void", before, after: { ...after, void_reason: reason }, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "sites", toSiteDTO(after)));
  });
}
