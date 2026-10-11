// P7：排程 job 唔係某個用戶 request，但部分唯讀 lib（month-health／unpriced）要 AuthedSession 做權限過濾。
// 用「最早建立嘅啟用中老闆」做讀者（只在記憶體，唔簽發 cookie、唔寫入）。
import { prisma } from "@/lib/db";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

export async function getJobReaderSession(): Promise<AuthedSession> {
  const u = await prisma.user.findFirst({ where: { status: "active", role: { baseRole: "老闆" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { role: true } });
  if (!u) throw new Error("冇啟用中嘅老闆帳號，job 無法讀取");
  return {
    userId: u.id,
    tel: u.tel,
    name: u.name,
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
