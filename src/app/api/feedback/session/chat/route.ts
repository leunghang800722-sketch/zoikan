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
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { ApiError, NotFound } from "@/lib/api/errors";
import { getClientIp } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { getSessionForUser, appendFeedbackTurn, turnCountOf, messagesOf, MAX_FEEDBACK_TURNS } from "@/lib/feedback/session";
import { computeFieldVisibility, scrubPhoneLike } from "@/lib/ai/field-scrub";
import { buildAiTools } from "@/lib/ai/tools";
import { buildFeedbackInterviewPrompt, type AiPageContext } from "@/lib/ai/feedback-prompt";
import { checkOutputGuardAndAudit } from "@/lib/ai/output-guard";
import { checkFeasibilityGuardAndAudit } from "@/lib/ai/feasibility-guard";
import { getLlmClient, LlmUnavailableError, type LlmHistoryTurn } from "@/lib/ai/llm";

const ChatRequestSchema = z
  .object({
    session_id: z.string().min(1),
    message: z.string().min(1, "問題唔可以係空").max(4000, "問題太長（上限 4000 字符）"),
    context: z
      .object({
        path: z.string().max(200).optional(),
        site_id: z.string().max(100).optional(),
        month: z.string().max(20).optional(),
        broker: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MAX_TOOL_ROUNDS = 8;
const SSE_CHUNK_SIZE = 40;
const EMPTY_REPLY_FALLBACK = "唔知點答，可以講清楚啲你想反映邊方面，或者換個講法再講一次？";

function withEmptyReplyFallback(text: string): string {
  return text.trim() === "" ? EMPTY_REPLY_FALLBACK : text;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireFeedbackAccess(req);
  } catch (err) {
    if (err instanceof ApiError) {
      return new Response(JSON.stringify({ error: err.code, message: err.message }), {
        status: err.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw err;
  }

  const ip = getClientIp(req);
  const bodyRaw = await readJson(req);
  let parsed: z.infer<typeof ChatRequestSchema>;
  try {
    parsed = parseBody(ChatRequestSchema, bodyRaw);
  } catch (err) {
    if (err instanceof ApiError) {
      return new Response(JSON.stringify({ error: err.code, message: err.message }), {
        status: err.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw err;
  }

  const feedbackSession = await getSessionForUser(parsed.session_id, session.userId);
  if (!feedbackSession || feedbackSession.status !== "draft") {
    const notFound = NotFound("呢個開會 session 唔存在或者已經結束");
    return new Response(JSON.stringify({ error: notFound.code, message: notFound.message }), {
      status: notFound.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (turnCountOf(feedbackSession) >= MAX_FEEDBACK_TURNS) {
    return new Response(
      JSON.stringify({ error: "feedback_turn_limit", message: "呢次開會已經傾咗好多輪，撳「整理並送出」或者「取消開會」啦。" }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  let llmClient;
  try {
    llmClient = getLlmClient();
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      return new Response(JSON.stringify({ error: "ai_provider_unavailable", message: err.message }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw err;
  }

  // P2.5：用戶輸入送去 LLM／存落 session 之前先過電話 pattern scrub——
  // 呼應「電話/銀行資料一律唔准送去 Anthropic/DeepSeek」（見
  // docs/ai-assistant.md），訪談對話一樣係送出去嘅內容，唔可以例外。
  const scrubbedMessage = scrubPhoneLike(parsed.message);

  const [fieldVisibility, historyRaw] = await Promise.all([
    computeFieldVisibility(session),
    Promise.resolve(messagesOf(feedbackSession)),
  ]);
  const history: LlmHistoryTurn[] = historyRaw.map((m) => ({ role: m.role, content: m.content }));
  const tools = buildAiTools({ session, fieldVisibility });
  const context: AiPageContext | undefined =
    parsed.context ?? (feedbackSession.pageContext as AiPageContext | null | undefined) ?? undefined;
  const systemPrompt = buildFeedbackInterviewPrompt(session, context);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await llmClient.chat({
          systemPrompt,
          tools,
          history,
          userMessage: scrubbedMessage,
          maxToolRounds: MAX_TOOL_ROUNDS,
        });

        // 安全 guard 先行（DML/DDL／指示性文字），先至行可行性 guard
        // （產品規則）——兩個獨立，順序上前者唔會俾後者削弱。
        const guardResult = await checkOutputGuardAndAudit({ text: withEmptyReplyFallback(result.text), actorUserId: session.userId, ip });
        const feasibilityResult = await checkFeasibilityGuardAndAudit({
          text: guardResult.text,
          actorUserId: session.userId,
          sessionId: feedbackSession.id,
          ip,
        });
        const finalText = feasibilityResult.text;

        for (const piece of chunk(finalText, SSE_CHUNK_SIZE)) {
          controller.enqueue(encoder.encode(sseEvent("delta", { text: piece })));
        }

        await appendFeedbackTurn(feedbackSession.id, scrubbedMessage, finalText);
        await writeAudit({
          actorUserId: session.userId,
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
          ip,
        });

        controller.enqueue(
          encoder.encode(
            sseEvent("done", {
              text: finalText,
              tools_used: result.toolsUsed,
              guard_triggered: guardResult.triggered,
              feasibility_guard_triggered: feasibilityResult.triggered,
            }),
          ),
        );
      } catch (err) {
        const message = err instanceof LlmUnavailableError ? err.message : "系統錯誤，請稍後再試";
        controller.enqueue(encoder.encode(sseEvent("error", { message })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
