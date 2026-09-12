import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { toBrokerFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 「作廢」同「解除作廢」用返同一個 module:void 權限——matrix.ts 嘅
    // action 只有五格，冇獨立 unvoid 動作，呢個係 WP2 執行裁定。
    const session = await requirePermission(req, "雞頭", "void");
    const { id } = await params;
    const before = await prisma.broker.findUniqueOrThrow({ where: { id } });
    const after = await prisma.broker.update({ where: { id }, data: { status: "active" } });
    await writeAudit({ actorUserId: session.userId, tableName: "brokers", rowId: id, action: "unvoid", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "brokers", toBrokerFullDTO(after)));
  });
}
