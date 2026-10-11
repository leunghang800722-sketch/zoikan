// POST /api/auth/login { tel, password } → set HTTP-only session cookie。
// 錯密碼鎖定：連續 5 次失敗鎖 15 分鐘（failed_attempts/locked_until，
// P1-執行計劃.md §4 WP2「電話＋密碼登入…failed_attempts 鎖定」）。P6.3：計數改原子、
// 加按 IP 限速、鎖定／未註冊／密碼錯對外統一 401（見下）。
// 登入 IP 記入 audit_log（設計文件§5.1「登入管制…配合audit_log」）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth/session";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { checkLoginAllowed, recordLoginFailure } from "@/lib/auth/login-rate-limit";
import { writeAudit } from "@/lib/audit";
import { getClientIp, handleApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { LoginSchema } from "@/lib/api/schemas";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// P6.3（H8）：「電話未註冊／帳號停用／帳號鎖定中／密碼錯」四種情況對外一律回
// 同一個 401 同一句訊息，唔洩露「呢個電話有註冊」或者「帳號已被鎖」；真正原因
// 只記 audit。
function invalidCredentials() {
  return NextResponse.json({ error: "invalid_credentials", message: "電話或密碼錯誤" }, { status: 401 });
}

// 未註冊／鎖定中都要跑一次 bcrypt，令回應時間唔會洩露帳號狀態。
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("p6-3-dummy-password");
  return dummyHash;
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.json().catch(() => ({}));
    const { tel: telRaw, password } = parseBody(LoginSchema, rawBody);
    const tel = telRaw.trim();

    const ip = getClientIp(req);
    const gate = checkLoginAllowed(ip);
    if (!gate.ok) {
      return NextResponse.json(
        { error: "too_many_requests", message: "登入嘗試太頻密，請稍後再試" },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      );
    }

    const user = await prisma.user.findUnique({ where: { tel }, include: { role: true } });

    if (!user || user.status !== "active") {
      await verifyPassword(password, await dummyPasswordHash());
      recordLoginFailure(ip);
      await writeAudit({
        actorUserId: user?.id ?? null,
        tableName: "users",
        rowId: user?.id ?? tel,
        action: "login_failed",
        ip,
        after: { reason: "not_found_or_inactive" },
      });
      return invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await verifyPassword(password, await dummyPasswordHash());
      recordLoginFailure(ip);
      await writeAudit({
        actorUserId: user.id,
        tableName: "users",
        rowId: user.id,
        action: "login_locked",
        ip,
        after: { lockedUntil: user.lockedUntil },
      });
      return invalidCredentials();
    }

    // 鎖定已過期 → 原子清零（條件式 updateMany，並發請求只有一個寫到），之後先重新計數。
    if (user.lockedUntil) {
      await prisma.user.updateMany({ where: { id: user.id, lockedUntil: { lte: new Date() } }, data: { failedAttempts: 0, lockedUntil: null } });
    }

    // 原子計數：先 `increment` 預留一次嘗試（DB 層原子，並發請求各自攞到唔同嘅
    // 序號），序號 > MAX 嘅請求根本唔驗密碼 → 並發 N 個錯密碼請求最多只有 5 個
    // 真係被驗。鎖定時 failed_attempts 保持 ≥ MAX（直至鎖定過期或成功登入／重設
    // 密碼先清零），令鎖定前已通過檢查嘅並發請求都唔會重新攞到序號。鎖定用條件式
    // updateMany（failedAttempts >= MAX 且未鎖）。成功登入 reset 計數。
    const reserved = await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    const lockAccount = async () => {
      const now = new Date();
      const res = await prisma.user.updateMany({
        where: { id: user.id, failedAttempts: { gte: MAX_FAILED_ATTEMPTS }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) },
      });
      return res.count > 0;
    };

    if (reserved.failedAttempts > MAX_FAILED_ATTEMPTS) {
      await verifyPassword(password, await dummyPasswordHash());
      recordLoginFailure(ip);
      await lockAccount();
      await writeAudit({ actorUserId: user.id, tableName: "users", rowId: user.id, action: "login_locked", ip, after: { attempts: reserved.failedAttempts, locked: true, reason: "over_attempt_quota" } });
      return invalidCredentials();
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      recordLoginFailure(ip);
      const locked = reserved.failedAttempts >= MAX_FAILED_ATTEMPTS ? await lockAccount() : false;
      await writeAudit({
        actorUserId: user.id,
        tableName: "users",
        rowId: user.id,
        action: locked ? "login_locked" : "login_failed",
        ip,
        after: { attempts: reserved.failedAttempts, locked },
      });
      return invalidCredentials();
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
