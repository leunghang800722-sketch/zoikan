import { assertNotSystemAccount } from "@/lib/system-user";
import { toUserDTO } from "@/lib/api/dto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { VoidReasonSchema } from "@/lib/api/schemas";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { writeAudit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "void");
    const { id } = await params;
    await assertNotSystemAccount(id);
    const body = await readJson(req);
    const { reason } = parseBody(VoidReasonSchema, body);
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const after = await prisma.user.update({ where: { id }, data: { status: "inactive" } });
    // Opus 驗收殘留1：void 之後（就算之後老闆手多重新 unvoid）都要求
    // 重新登入——唔靠淨係 status check（防止 unvoid 之後舊 session 即刻
    // 復活）。
    await bumpTokenVersion(id);
    const dto = toUserDTO(after, true);
    await writeAudit({
      actorUserId: session.userId,
      tableName: "users",
      rowId: id,
      action: "void",
      before: toUserDTO(before, true),
      after: { ...dto, void_reason: reason },
      ip: getClientIp(req),
    });
    return ok(dto);
  });
}
