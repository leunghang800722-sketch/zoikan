import { assertNotSystemAccount } from "@/lib/system-user";
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { toUserDTO } from "@/lib/api/dto";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { UserUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "view");
    const { id } = await params;
    const row = await prisma.user.findUnique({ where: { id } });
    if (!row) throw NotFound();
    const includeManagementFields = await hasPermission(session, "用戶管理", "view");
    return ok(toUserDTO(row, includeManagementFields));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "update");
    const { id } = await params;
    await assertNotSystemAccount(id);
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(UserUpdateSchema, body);

    // S7：改 broker_id 都要驗證 kind='broker'。
    if (parsed.broker_id) {
      const broker = await prisma.broker.findUnique({ where: { id: parsed.broker_id }, select: { kind: true } });
      if (!broker || broker.kind !== "broker") throw BadRequest("broker_id 一定要指向 kind='broker' 嘅雞頭");
    }

    const data = snakeToCamelShallow(parsed) as Prisma.UserUncheckedUpdateInput;
    const after = await prisma.user.update({ where: { id }, data });
    // Opus 驗收殘留1：改角色／改 broker 令呢個用戶所有現存 session 即刻
    // 失效（下次帶舊 cookie 嘅 request 會俾 requireSession() 嘅
    // token_version check 拒 401）——用新權限之前嘅 session 唔應該仲用
    // 緊舊權限做嘢。
    if (parsed.role_id !== undefined && parsed.role_id !== before.roleId) await bumpTokenVersion(id);
    else if (parsed.broker_id !== undefined && parsed.broker_id !== before.brokerId) await bumpTokenVersion(id);
    await writeAudit({
      actorUserId: session.userId,
      tableName: "users",
      rowId: id,
      action: "update",
      before: toUserDTO(before, true),
      after: toUserDTO(after, true),
      ip: getClientIp(req),
    });
    return ok(toUserDTO(after, true));
  });
}
