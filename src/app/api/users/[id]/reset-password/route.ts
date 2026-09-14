// P2-C 新增（additive）：用戶管理頁（README §16）要求一粒「重設密碼」
// 操作掣，但之前個 API 完全冇對稱嘅 endpoint（用戶管理淨係有 create/
// update/void/unvoid）。跟 void/unvoid 嘅寫法：淨係用返現有「用戶管理:
// update」權限（冇加新 permission/module，權限矩陣不變），生成一次性
// 臨時密碼、逼下次登入要改密碼（must_change_pwd=true）、bump token
// version（舊 session 即刻失效，同 void 一致），寫 audit（action=
// reset_password；before/after 用返 toUserDTO()，唔記錄明文密碼）。
// 回應淨係呢一次性返返個臨時密碼俾管理員自己交俾用戶，之後查唔返。
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toUserDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { hashPassword } from "@/lib/auth/password";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";

// 排走容易睇錯嘅字符（0/O、1/I/l）；一半字母一半數字，保證兩者都有，
// 唔使再驗一次 isStrongPassword()（管理角色都要求含字母+數字，呢個
// pattern 本身已經滿足）。
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";

function generateTempPassword(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const pool = i % 2 === 0 ? LETTERS : DIGITS;
    out += pool[bytes[i] % pool.length];
  }
  return out;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "update");
    const { id } = await params;
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const after = await prisma.user.update({ where: { id }, data: { passwordHash, mustChangePwd: true } });
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
