// P2.5「現場反映」開會模式——`GET /api/feedback/unread-count`：老闆左欄
// 「現場意見」badge 用（status=new 數）。同 `(app)/layout.tsx` 嘅審批
// badge 一樣做法（server count，見 `src/app/(app)/layout.tsx`）。
import { prisma } from "@/lib/db";
import { requireFeedbackAccess, assertBoss } from "@/lib/feedback/guard";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    assertBoss(session);
    const count = await prisma.feedbackReport.count({ where: { status: "new" } });
    return ok(brandSafeResponse({ count }));
  });
}
