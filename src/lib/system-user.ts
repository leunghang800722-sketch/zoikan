// P8 驗收 M1：排程系統帳號。所有 job 內部寫入（一鍵結算 run、價卡、audit…）嘅 actor／started_by／created_by 用呢個帳號，
// 唔再借用任何老闆個人帳號（審計誤導、老闆停用就 job 壞）。
//  - tel 固定保留值 `00000000`、name「系統排程」、status=inactive（登入 route 拒絕非 active → 401）、
//    password_hash 係永遠 match 唔到嘅非 bcrypt 字串、role＝老闆（job 內部寫入經 lib 權限檢查時有老闆權限）。
//  - id 唔 hardcode：startup（scripts/db/ensure-system-user.ts）或 job 首次用嗰陣冪等建立。
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";

import { SYSTEM_USER_TEL } from "@/lib/system-user-const";
export { SYSTEM_USER_TEL };
export const SYSTEM_USER_NAME = "系統排程";
const NEVER_MATCH_HASH = "!system-account-no-login";

/** 冪等建立／校正系統帳號，回 user id。 */
export async function ensureSystemUser(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { tel: SYSTEM_USER_TEL }, include: { role: true } });
  if (existing) {
    if (existing.status !== "inactive" || existing.passwordHash !== NEVER_MATCH_HASH || existing.role.baseRole !== "老闆") {
      const role = existing.role.baseRole === "老闆" ? existing.role : await findBossRole();
      await prisma.user.update({ where: { id: existing.id }, data: { status: "inactive", passwordHash: NEVER_MATCH_HASH, roleId: role.id } });
    }
    return existing.id;
  }
  const role = await findBossRole();
  const created = await prisma.user.create({ data: { name: SYSTEM_USER_NAME, tel: SYSTEM_USER_TEL, passwordHash: NEVER_MATCH_HASH, roleId: role.id, status: "inactive" }, select: { id: true } });
  return created.id;
}

async function findBossRole() {
  const role = await prisma.role.findFirst({ where: { baseRole: "老闆" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!role) throw new Error("搵唔到老闆角色，建立唔到系統帳號");
  return role;
}

/** 只查唔建（權限判斷用）；未建立回 null。 */
export async function getSystemUserId(): Promise<string | null> {
  return (await prisma.user.findUnique({ where: { tel: SYSTEM_USER_TEL }, select: { id: true } }))?.id ?? null;
}

/** M3：系統帳號唔可以經 users 管理 API 被改／恢復／重設密碼／作廢／改通知電郵（伺服器端擋）。 */
export async function assertNotSystemAccount(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tel: true } });
  if (u?.tel === SYSTEM_USER_TEL) throw new ApiError(403, "system_account", "系統排程帳號唔可以經用戶管理修改");
}
