// P2.5「現場反映」開會模式——`POST /api/feedback/session`：開／續 draft。
// 一個用戶同時最多一個 draft（`getOrCreateDraftSession()`，application
// 層保證）——撳側欄「開會反映」掣，前端每次都打呢個 endpoint，有現有
// draft 就直接續用（可以順手更新 page_context），冇就開新嘅。
//
// P2.5 Opus 驗收應修④：每人每日最多開 `MAX_FEEDBACK_SESSIONS_PER_DAY`
// 個 session（唔叫 LLM，但都要設上限——見 `src/lib/feedback/session.ts`
// 常數頂註解）。淨係喺「呢次冇現有 draft 可以續用（即係一定會插一行
// 新記錄）」先核呢個上限——續用現有 draft 唔受影響。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { ApiError } from "@/lib/api/errors";
import { ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import {
  findDraftSession,
  getOrCreateDraftSession,
  messagesOf,
  turnCountOf,
  countSessionsOpenedToday,
  MAX_FEEDBACK_SESSIONS_PER_DAY,
} from "@/lib/feedback/session";
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

    // 冇現有 draft 先要插一行新記錄——先至核每日開 session 上限（續用
    // 現有 draft 嘅情況唔受影響，直接落去 getOrCreateDraftSession()）。
    const existingDraft = await findDraftSession(session.userId);
    if (!existingDraft) {
      const openedToday = await countSessionsOpenedToday(session.userId);
      if (openedToday >= MAX_FEEDBACK_SESSIONS_PER_DAY) {
        throw new ApiError(
          429,
          "feedback_session_limit",
          `今日已經開咗 ${openedToday} 次開會，上限 ${MAX_FEEDBACK_SESSIONS_PER_DAY} 次，聽日再嚟啦。`,
        );
      }
    }

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
