// POST /api/auth/change-password { old_password, new_password }
// 管理角色（老闆／主管／會計）強制強密碼（P1-執行計劃.md §4 WP2「管理角色
// 強制強密碼」）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { verifyPassword, hashPassword, isStrongPassword, requiresStrongPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";
import { getClientIp, handleApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { ChangePasswordSchema } from "@/lib/api/schemas";
import { BadRequest } from "@/lib/api/errors";

// P3：改自己密碼一律經「個人資料:update」（五角色出廠皆✓，見
// src/lib/rbac/matrix.ts）——同其他寫入 route 待遇一致，唔再淨係
// 「得個未登入 check」就算，仲寫返 audit_log(permission_denied) 如果
// 有人整走呢個 permission。
export async function POST(req: Request) {
  try {
    const session = await requirePermission(req, "個人資料", "update");

    const rawBody = await req.json().catch(() => ({}));
    const { old_password: oldPassword, new_password: newPassword } = parseBody(ChangePasswordSchema, rawBody);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId }, include: { role: true } });
    const valid = await verifyPassword(oldPassword, user.passwordHash);
    if (!valid) throw BadRequest("舊密碼不正確");

    if (requiresStrongPassword(user.role.name) && !isStrongPassword(newPassword)) {
      throw BadRequest("管理角色密碼要求：至少 8 字符，包含字母同數字");
    }
    if (!isStrongPassword(newPassword) && newPassword.length < 6) {
      throw BadRequest("密碼至少 6 字符");
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePwd: false } });
    // Opus 驗收殘留1：改密碼要 bump token_version——所有「舊密碼時代」
    // issue 嘅 session（包括其他裝置嘅）即刻失效。當前呢個 request 重新
    // issue 一個帶新 version 嘅 cookie，等緊用緊嘅呢一個 session 唔使
    // 即刻俾自己踢出（典型安全 UX：改密碼淨係踢走其他裝置，唔踢自己）。
    const newTokenVersion = await bumpTokenVersion(user.id);

    await writeAudit({ actorUserId: user.id, tableName: "users", rowId: user.id, action: "change_password", ip: getClientIp(req) });

    const res = NextResponse.json({ ok: true });
    await setSessionCookie(res, { ...session, tokenVersion: newTokenVersion });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
