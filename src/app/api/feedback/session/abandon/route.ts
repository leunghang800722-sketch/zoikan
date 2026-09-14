// P2.5「現場反映」開會模式——`POST /api/feedback/session/abandon`：用戶
// 撳「取消開會」，session 標做 abandoned（唔寫 feedback_reports）。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { NotFound } from "@/lib/api/errors";
import { ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { z } from "zod";
import { getSessionForUser, markSessionStatus } from "@/lib/feedback/session";

const AbandonRequestSchema = z.object({ session_id: z.string().min(1) }).strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    const body = await readJson(req);
    const parsed = parseBody(AbandonRequestSchema, body);

    const feedbackSession = await getSessionForUser(parsed.session_id, session.userId);
    if (!feedbackSession || feedbackSession.status !== "draft") throw NotFound("呢個開會 session 唔存在或者已經結束");

    await markSessionStatus(feedbackSession.id, "abandoned");
    return ok(brandSafeResponse({ ok: true }));
  });
}
