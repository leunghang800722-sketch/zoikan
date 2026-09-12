// POST /api/auth/login { tel, password } → set HTTP-only session cookie。
// 錯密碼鎖定：連續 5 次失敗鎖 15 分鐘（failed_attempts/locked_until，
// P1-執行計劃.md §4 WP2「電話＋密碼登入…failed_attempts 鎖定」）。
// 登入 IP 記入 audit_log（設計文件§5.1「登入管制…配合audit_log」）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";
import { getClientIp, handleApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { LoginSchema } from "@/lib/api/schemas";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export async function POST(req: Request) {
  try {
    const rawBody = await req.json().catch(() => ({}));
    const { tel: telRaw, password } = parseBody(LoginSchema, rawBody);
    const tel = telRaw.trim();

    const ip = getClientIp(req);
    const user = await prisma.user.findUnique({ where: { tel }, include: { role: true } });

    // 電話搵唔到都用同一個錯誤訊息（唔洩露「呢個電話有冇註冊」）
    if (!user || user.status !== "active") {
      await writeAudit({
        actorUserId: user?.id ?? null,
        tableName: "users",
        rowId: user?.id ?? tel,
        action: "login_failed",
        ip,
        after: { reason: "not_found_or_inactive" },
      });
      return NextResponse.json({ error: "invalid_credentials", message: "電話或密碼錯誤" }, { status: 401 });
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await writeAudit({
        actorUserId: user.id,
        tableName: "users",
        rowId: user.id,
        action: "login_locked",
        ip,
        after: { lockedUntil: user.lockedUntil },
      });
      return NextResponse.json(
        { error: "account_locked", message: `帳號已鎖定，${user.lockedUntil.toISOString()} 後先可以再試` },
        { status: 423 },
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const attempts = user.failedAttempts + 1;
      const locked = attempts >= MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: locked ? 0 : attempts,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await writeAudit({
        actorUserId: user.id,
        tableName: "users",
        rowId: user.id,
        action: locked ? "login_locked" : "login_failed",
        ip,
        after: { attempts, locked },
      });
      if (locked) {
        return NextResponse.json(
          { error: "account_locked", message: `連續 ${MAX_FAILED_ATTEMPTS} 次密碼錯誤，帳號鎖定 ${LOCK_MINUTES} 分鐘` },
          { status: 423 },
        );
      }
      return NextResponse.json({ error: "invalid_credentials", message: "電話或密碼錯誤" }, { status: 401 });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
      select: { tokenVersion: true },
    });

    await writeAudit({ actorUserId: user.id, tableName: "users", rowId: user.id, action: "login", ip, after: { tel: user.tel } });

    const res = NextResponse.json({
      user: { id: user.id, name: user.name, tel: user.tel, role: user.role.name, must_change_pwd: user.mustChangePwd },
    });
    await setSessionCookie(res, {
      userId: user.id,
      tel: user.tel,
      name: user.name,
      roleId: user.roleId,
      roleName: user.role.name,
      baseRole: user.role.baseRole,
      brokerId: user.brokerId,
      guardId: user.guardId,
      payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
      tokenVersion: updated.tokenVersion,
      loggedInAt: new Date().toISOString(),
    });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
