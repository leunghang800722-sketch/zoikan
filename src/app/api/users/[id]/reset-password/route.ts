// P2-C 新增（additive）：用戶管理頁（README §16）要求一粒「重設密碼」
// 操作掣，但之前個 API 完全冇對稱嘅 endpoint（用戶管理淨係有 create/
// update/void/unvoid）。跟 void/unvoid 嘅寫法：淨係用返現有「用戶管理:
// update」權限（冇加新 permission/module，權限矩陣不變），生成一次性
// 臨時密碼、逼下次登入要改密碼（must_change_pwd=true）、bump token
// version（舊 session 即刻失效，同 void 一致），寫 audit（action=
// reset_password；before/after 用返 toUserDTO()，唔記錄明文密碼）。
// 回應淨係呢一次性返返個臨時密碼俾管理員自己交俾用戶，之後查唔返。
//
// A1（Opus 驗收）：重設密碼最常見嘅情況就係用戶俾自己撳錯密碼鎖咗
// （failed_attempts 累積到 locked_until），管理員重設咗新密碼但個戶口
// 仲鎖住就冇意思——重設嗰陣一齊清返 failed_attempts=0／locked_until=
// null。
//
// A2（Opus 驗收）：唔准對自己重設——應該用改密碼頁（見
// src/app/api/auth/change-password/route.ts），否則管理員撳一下自己
// 就即刻俾自己嘅 session token_version bump 走，變相自己鎖自己出。
import { assertNotSystemAccount } from "@/lib/system-user";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toUserDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { hashPassword } from "@/lib/auth/password";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { BadRequest, NotFound } from "@/lib/api/errors";

// 排走容易睇錯嘅字符（0/O、1/I/l）；一半字母一半數字，保證兩者都有，
// 唔使再驗一次 isStrongPassword()（管理角色都要求含字母+數字，呢個
// pattern 本身已經滿足）。長度 12（細節要求 ≥ 12）。
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const PASSWORD_LENGTH = 12;

// 細節（Opus 驗收）：舊版 `bytes[i] % pool.length` 有 modulo bias（256
// 除唔盡 pool.length，細數值嘅字符會俾抽中嘅機會率略高）。改用 rejection
// sampling——`max` 係細過 256 嘅最大嘅 `pool.length` 倍數，抽到 ≥ max
// 嘅 byte 就掉咗重抽，保證每個字符出現機會率完全相等。
function randomIndex(poolSize: number): number {
  const max = 256 - (256 % poolSize);
  let byte: number;
  do {
    byte = randomBytes(1)[0]!;
  } while (byte >= max);
  return byte % poolSize;
}

function generateTempPassword(): string {
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    const pool = i % 2 === 0 ? LETTERS : DIGITS;
    out += pool[randomIndex(pool.length)];
  }
  return out;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "update");
    const { id } = await params;
    await assertNotSystemAccount(id);
    if (id === session.userId) throw BadRequest("請用改密碼頁改自己嘅密碼");
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) throw NotFound();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const after = await prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePwd: true, failedAttempts: 0, lockedUntil: null },
    });
    await bumpTokenVersion(id);
    await writeAudit({
      actorUserId: session.userId,
      tableName: "users",
      rowId: id,
      action: "reset_password",
      before: toUserDTO(before, true),
      after: toUserDTO(after, true),
      ip: getClientIp(req),
    });
    return ok(brandSafeResponse({ temp_password: tempPassword }));
  });
}
