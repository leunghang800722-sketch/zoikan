// WP-ONE-CLICK-AUTO（§31.2／§31.3 E）：`POST /api/month-close/one-click/:id/undo-auto`——
// 一鍵還原呢個 run 所有 `auto` 改動（價卡作廢、別名移除、更種作廢（冇更次用緊先准）、
// 結算雞頭還原、自動配對還原）。已鎖月份唔准；全部 audit（auto_source=undo:one-click:<runId>）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "一鍵結算", "update");
    const { id } = await params;
    const result = await undoAutoChanges(id, session.userId, getClientIp(req));
    return ok(brandSafeResponse({ run_id: result.runId, undone: result.undone, skipped: result.skipped, already_undone: result.alreadyUndone, superseded_questions: result.supersededQuestions, still_using_voided_card_prices: result.stillUsingVoidedCardPrices }));
  });
}
