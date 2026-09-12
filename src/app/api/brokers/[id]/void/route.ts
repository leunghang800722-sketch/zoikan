// 作廢＝status→inactive（冇刪除，設計文件§5.0「只有作廢冇刪除」）。
// 原因必填，留喺 audit_log.after（唔另加 voidReason 欄，audit_log 已經係
// 原因嘅唯一事實來源）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { toBrokerFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "雞頭", "void");
    const { id } = await params;
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);

    const before = await prisma.broker.findUniqueOrThrow({ where: { id } });
    const after = await prisma.broker.update({ where: { id }, data: { status: "inactive" } });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "brokers",
      rowId: id,
      action: "void",
      before,
      after: { ...after, void_reason: reason },
      ip: getClientIp(req),
    });
    return ok(await applyFieldGroupGate(session, "brokers", toBrokerFullDTO(after)));
  });
}
