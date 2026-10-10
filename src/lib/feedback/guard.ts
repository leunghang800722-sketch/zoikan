// P2.5「現場反映」開會模式——共用權限 helper。全部 `/api/feedback/**`
// route 一致用 `requirePermission(req,"助手","view")` 做基本進入權（同
// AI 助手一樣，雞頭/保安員硬性禁止）；「老闆專用」嘅 endpoint（睇意見
// 清單／改狀態／未讀數）額外核 `baseRole==="老闆"`——刻意**唔改
// `matrix.ts` 加新 module**（鐵律），直接用 baseRole 判斷,同
// `src/lib/ai/tools/list-feedback.ts` 掛載邏輯一致做法。
import { requirePermission } from "../rbac/requirePermission";
import type { AuthedSession } from "../rbac/requirePermission";
import { Forbidden } from "../api/errors";

export async function requireFeedbackAccess(req: Request): Promise<AuthedSession> {
  return requirePermission(req, "助手", "view");
}

export function assertBoss(session: AuthedSession): void {
  if (session.baseRole !== "老闆") {
    throw Forbidden("呢個功能淨係老闆先用得到");
  }
}
