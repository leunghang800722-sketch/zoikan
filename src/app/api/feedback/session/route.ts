// P2.5「現場反映」開會模式——`POST /api/feedback/session`：開／續 draft。
// 一個用戶同時最多一個 draft（`getOrCreateDraftSession()`，application
// 層保證）——撳側欄「開會反映」掣，前端每次都打呢個 endpoint，有現有
// draft 就直接續用（可以順手更新 page_context），冇就開新嘅。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { getOrCreateDraftSession, messagesOf, turnCountOf } from "@/lib/feedback/session";
import { z } from "zod";

const PageContextSchema = z
  .object({
    path: z.string().max(200).optional(),
    site_id: z.string().max(100).optional(),
    month: z.string().max(20).optional(),
    broker: z.string().max(100).optional(),
  })
  .strict()
  .optional();

const OpenSessionSchema = z.object({ page_context: PageContextSchema }).strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    const body = await readJson(req);
    const parsed = parseBody(OpenSessionSchema, body);

    const feedbackSession = await getOrCreateDraftSession(session.userId, parsed.page_context);

    return ok(
      brandSafeResponse({
        id: feedbackSession.id,
        status: feedbackSession.status,
        messages: messagesOf(feedbackSession),
        page_context: feedbackSession.pageContext,
        turn_count: turnCountOf(feedbackSession),
      }),
    );
  });
}
