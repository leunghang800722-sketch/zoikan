// P7：排程 job 唔係某個用戶 request，但部分唯讀 lib（month-health／unpriced）要 AuthedSession 做權限過濾。
// P8 驗收 M1：改用排程系統帳號（`src/lib/system-user.ts`，inactive、老闆權限），唔再借用任何老闆個人帳號
// （只在記憶體，唔簽發 cookie）。老闆帳號停用唔影響 job。
import { prisma } from "@/lib/db";
import { ensureSystemUser, SYSTEM_USER_NAME } from "@/lib/system-user";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

export async function getJobReaderSession(): Promise<AuthedSession> {
  const id = await ensureSystemUser();
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { role: true } });
  return {
    userId: u.id,
    tel: u.tel,
    name: SYSTEM_USER_NAME,
    roleId: u.roleId,
    roleName: u.role.name,
    baseRole: "老闆",
    brokerId: null,
    guardId: null,
    payoutApprovalLimit: null,
    tokenVersion: u.tokenVersion,
    loggedInAt: new Date().toISOString(),
  };
}
