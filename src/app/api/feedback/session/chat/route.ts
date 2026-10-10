// P2.5「現場反映」開會模式——`POST /api/feedback/session/chat`：訪談員
// 對話，SSE（同 `/api/ai/chat` 一樣傳輸做法，見嗰個 route 頂註解嘅設計
// 決定：唔逐 token 即時轉發，等 guard 行完先送出）。
//
// 同 `/api/ai/chat` 嘅分別：
// 1. system prompt 用訪談員版（`buildFeedbackInterviewPrompt()`，唔係
//    答數據問題嘅 `buildSystemPrompt()`）。
// 2. 工具集＝現有只讀工具（`buildAiTools()`）——訪談員可以查數幫理解，
//    但答案要行埋落面嘅 guard。
// 3. 兩層輸出 guard：先行現有 `checkOutputGuardAndAudit()`（安全底線，
//    DML/DDL/指示性文字），先至行新嘅 `checkFeasibilityGuardAndAudit()`
//    （產品規則：訪談員唔評可行性）——順序上安全guard永遠行先，唔會被
//    可行性 guard 削弱或者繞過。
// 4. 用戶輸入送去 LLM 之前先過 `scrubPhoneLike()`（呼應「電話/銀行資料
//    唔准送去 Anthropic/DeepSeek 處理」——訪談對話都係送出去嘅內容）。
// 5. session 上限 40 輪——撞到就 429，前端引導「整理並送出」／「取消
//    開會」。
// 6. audit action 用 `ai_feedback_chat`（唔係 `ai_chat`），`row_id` 用
//    session id（唔係 user id）——等一個用戶多次開會嘅記錄分得開。
// 7. P2.5 Opus 驗收應修④：呢度真係叫 LLM，同 `/api/ai/chat` **共用同
//    一個每日額度**（`assertUnderDailyLimit()`），撞到上限一樣 429。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { NotFound } from "@/lib/api/errors";
import { z } from "zod";
import { getSessionForUser, appendFeedbackTurn, turnCountOf, messagesOf, MAX_FEEDBACK_TURNS } from "@/lib/feedback/session";
import { scrubPhoneLike } from "@/lib/ai/field-scrub";
import { buildFeedbackInterviewPrompt, type AiPageContext } from "@/lib/ai/feedback-prompt";
import { checkOutputGuardAndAudit } from "@/lib/ai/output-guard";
import { checkFeasibilityGuardAndAudit } from "@/lib/ai/feasibility-guard";
import { ChatContextSchema, ChatMessageSchema, handleChatRequest, jsonResponse, withEmptyReplyFallback } from "@/lib/ai/chat-handler";

// P3-5.3：SSE 骨架抽去 `@/lib/ai/chat-handler`（見嗰個檔頂註解），呢個 route 淨係剩差異。
const ChatRequestSchema = z
  .object({
    session_id: z.string().min(1),
    message: ChatMessageSchema,
    context: ChatContextSchema,
  })
  .strict();

const EMPTY_REPLY_FALLBACK = "唔知點答，可以講清楚啲你想反映邊方面，或者換個講法再講一次？";

type ChatBody = z.infer<typeof ChatRequestSchema>;
type FeedbackSessionRow = NonNullable<Awaited<ReturnType<typeof getSessionForUser>>>;

export async function POST(req: Request) {
  return handleChatRequest<ChatBody, { feedbackSession: FeedbackSessionRow }>(req, {
    authorize: requireFeedbackAccess,
    bodySchema: ChatRequestSchema,
    prepare: async ({ session, parsed }) => {
      const feedbackSession = await getSessionForUser(parsed.session_id, session.userId);
      if (!feedbackSession || feedbackSession.status !== "draft") {
        const notFound = NotFound("呢個開會 session 唔存在或者已經結束");
        return { response: jsonResponse(notFound.status, { error: notFound.code, message: notFound.message }) };
      }
      if (turnCountOf(feedbackSession) >= MAX_FEEDBACK_TURNS) {
        return {
          response: jsonResponse(429, { error: "feedback_turn_limit", message: "呢次開會已經傾咗好多輪，撳「整理並送出」或者「取消開會」啦。" }),
        };
      }
      return { prep: { feedbackSession } };
    },
    loadHistory: async ({ prep }) => messagesOf(prep.feedbackSession),
    // P2.5：用戶輸入送去 LLM／存落 session 之前先過電話 pattern scrub——
    // 呼應「電話/銀行資料一律唔准送去 Anthropic/DeepSeek」（見
    // docs/ai-assistant.md），訪談對話一樣係送出去嘅內容，唔可以例外。
    compose: ({ session, parsed, prep }) => {
      const context: AiPageContext | undefined =
        parsed.context ?? (prep.feedbackSession.pageContext as AiPageContext | null | undefined) ?? undefined;
      return { systemPrompt: buildFeedbackInterviewPrompt(session, context), userMessage: scrubPhoneLike(parsed.message) };
    },
    finalize: async ({ session, parsed, prep, ip, result }) => {
      const feedbackSession = prep.feedbackSession;
      const scrubbedMessage = scrubPhoneLike(parsed.message);
      // 安全 guard 先行（DML/DDL／指示性文字），先至行可行性 guard
      // （產品規則）——兩個獨立，順序上前者唔會俾後者削弱。
      const guardResult = await checkOutputGuardAndAudit({ text: withEmptyReplyFallback(result.text, EMPTY_REPLY_FALLBACK), actorUserId: session.userId, ip });
      const feasibilityResult = await checkFeasibilityGuardAndAudit({
        text: guardResult.text,
        actorUserId: session.userId,
        sessionId: feedbackSession.id,
        ip,
      });
      const finalText = feasibilityResult.text;
      return {
        finalText,
        persist: () => appendFeedbackTurn(feedbackSession.id, scrubbedMessage, finalText),
        audit: {
          tableName: "ai_feedback_chat",
          rowId: feedbackSession.id,
          action: "ai_feedback_chat",
          after: {
            session_id: feedbackSession.id,
            tools_used: result.toolsUsed,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            guard_triggered: guardResult.triggered,
            feasibility_guard_triggered: feasibilityResult.triggered,
          },
        },
        done: {
          text: finalText,
          tools_used: result.toolsUsed,
          guard_triggered: guardResult.triggered,
          feasibility_guard_triggered: feasibilityResult.triggered,
        },
      };
    },
  });
}
