// P7.1：/api/admin/jobs 共用——老闆專用。
import { Forbidden } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

export function assertBossOnly(session: AuthedSession): void {
  if (session.baseRole !== "老闆") throw Forbidden("呢個功能淨係老闆先用得到");
}
