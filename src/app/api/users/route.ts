import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { toUserDTO, mapListDTO } from "@/lib/api/dto";
import { hashPassword, isStrongPassword, requiresStrongPassword } from "@/lib/auth/password";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { UserCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    const where: Prisma.UserWhereInput = includeInactive ? {} : { status: "active" };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where, skip, take, orderBy: { createdAt: "asc" }, include: { role: true } }),
      prisma.user.count({ where }),
    ]);
    // P5：failed_attempts/locked_until/allowed_ip 淨係 用戶管理:view
    // 先見到——route 本身已經要求呢個權限，但抽做獨立 field group
    // 令呢個限制係結構性保證，唔靠「岩岩好個 route 要求緊」。
    const includeManagementFields = await hasPermission(session, "用戶管理", "view");
    const dto = mapListDTO({ rows, total, skip, take }, (r) => toUserDTO(r, includeManagementFields));
    return ok(dto);
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "create");
    const body = await readJson(req);
    const input = parseBody(UserCreateSchema, body);

    const role = await prisma.role.findUnique({ where: { id: input.role_id } });
    if (!role) throw BadRequest("role_id 唔存在");
    if (requiresStrongPassword(role.name) && !isStrongPassword(input.password)) {
      throw BadRequest("管理角色（老闆/主管/會計）密碼要求：至少 8 字符，包含字母同數字");
    }
    if (!isStrongPassword(input.password) && input.password.length < 6) throw BadRequest("密碼至少 6 字符");

    // S7：broker_id 一定要指向 kind='broker' 嘅雞頭（internal_cash／
    // special 呢類唔可以拎嚟做「雞頭登入」用嘅 broker_id，否則個
    // requireOwnBrokerId()／broker-isolation 一套嘢會用錯資料）。
    if (input.broker_id) {
      const broker = await prisma.broker.findUnique({ where: { id: input.broker_id }, select: { kind: true } });
      if (!broker || broker.kind !== "broker") throw BadRequest("broker_id 一定要指向 kind='broker' 嘅雞頭");
    }

    const existing = await prisma.user.findUnique({ where: { tel: input.tel } });
    if (existing) throw Conflict("呢個電話已經有帳號");

    const passwordHash = await hashPassword(input.password);
    const created = await prisma.user.create({
      data: {
        name: input.name,
        tel: input.tel,
        passwordHash,
        roleId: input.role_id,
        guardId: input.guard_id ?? null,
        brokerId: input.broker_id ?? null,
        payoutApprovalLimit: input.payout_approval_limit ?? null,
        allowedIp: input.allowed_ip ?? null,
        mustChangePwd: input.must_change_pwd === true,
        createdBy: session.userId,
      },
    });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "users",
      rowId: created.id,
      action: "create",
      after: toUserDTO(created, true),
      ip: getClientIp(req),
    });
    return ok(toUserDTO(created, true), 201);
  });
}
