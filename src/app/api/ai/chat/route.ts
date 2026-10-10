// WP-AI1：`POST /api/ai/chat`——側欄 AI 助手主入口，SSE 串流。
//
// 鐵律（老闆 2026-09-12）：呢個助手**架構上做唔到任何寫入／修改／部署**。
// 呢個 route 本身淨係：驗證權限／daily limit → 讀對話 history → 用
// injectable 嘅 `LlmClient`（`@/lib/ai/llm.ts`，production 真係 call
// Anthropic SDK，測試用 fake）行 tool-use loop → 輸出過濾 → 存對話 +
// audit。**唔用 `@/lib/db`／唔寫 `prisma.`／唔碰任何寫入 API**（結構性
// 保證見 tests/ai-structural-guard.test.ts）。
//
// 設計決定（SSE 串流嘅取捨，見 docs/ai-assistant.md）：呢度**唔會**將
// 模型原始 token 即時轉發俾用戶——先喺 server 側儲齊成個回覆，行完
// `checkOutputGuardAndAudit()`（第 3.5 點嘅輸出過濾）先至將（可能已經
// 被換成標準回覆嘅）最終文字，切做幾嚿用 SSE `delta` event 送出，跟住
// 一個 `done` event。咁樣保證用戶（同存落 conversation/audit 嘅記錄）
// 一定唔會見到未經 guard 嘅原始輸出，代價係唔係逐 token 嘅「真」即時
// 串流（已知限制，見文件）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { safeErrorSummary } from "@/lib/api/http";
import { writeAppErrorLog } from "@/lib/app-error-log";
import { extractActions } from "@/lib/ai/actions";
import { dropGuardedActions, dropLockedMonthActions } from "@/lib/ai-actions-filter";
import { z } from "zod";
import { getConversation, appendConversationTurn } from "@/lib/ai-conversation";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { checkOutputGuardAndAudit } from "@/lib/ai/output-guard";
import { applyOutputStyleGuard } from "@/lib/ai/output-style";
import { LlmUnavailableError } from "@/lib/ai/llm";
import { ChatContextSchema, ChatMessageSchema, handleChatRequest, withEmptyReplyFallback } from "@/lib/ai/chat-handler";

// P3-5.3：SSE 骨架（session／額度／body 校驗／LlmClient／切 chunk／audit／error event）
// 抽去 `@/lib/ai/chat-handler`，呢個 route 淨係剩差異：prompt、輸出 guard 鏈、存儲、audit／done payload。
// WP-AI2：`context` 由前端側欄由目前網址解析出嚟（更表頁嘅 site_id/month、報表頁嘅 month），
// 純粹係俾 system prompt 加一段提示（見 `buildSystemPrompt()`），**唔係指令、唔經任何驗證**。
const ChatRequestSchema = z
  .object({
    message: ChatMessageSchema,
    context: ChatContextSchema,
  })
  .strict();

// WP-AI3 第三輪正式站 live 驗收發現：長對話入面偶爾會撞到 LlmClient
// 回一句完全空白嘅 `text`（真 LLM 嘅罕見情況，唔止某個 provider 先有，
// 兩邊都有機會撞到）——用戶側會見到一個完全冇字嘅回覆，好差嘅體驗。
// 呢個 fallback 淨係喺 `result.text` 淨係空白先套用，唔會影響任何有
// 內容嘅回覆，亦都唔會削弱 guard（fallback 文字本身乾淨，行齊
// checkOutputGuardAndAudit()／applyOutputStyleGuard() 都通過）。
const EMPTY_REPLY_FALLBACK = "唔知點答呢條問題，可以講清楚啲想問邊方面，或者換個講法再問一次？";

export async function POST(req: Request) {
  return handleChatRequest(req, {
    authorize: (r) => requirePermission(r, "助手", "view"),
    bodySchema: ChatRequestSchema,
    loadHistory: ({ session }) => getConversation(session.userId),
    compose: ({ session, parsed }) => ({ systemPrompt: buildSystemPrompt(session, parsed.context), userMessage: parsed.message }),
    finalize: async ({ session, parsed, ip, llmClient, result }) => {
      // WP-AI-DIAG（§37.4）：喺安全 guard 之前先剝走 ```actions block；剩低文字照舊行 guard。
      const extracted = extractActions(result.text);
      const guardResult = await checkOutputGuardAndAudit({ text: withEmptyReplyFallback(extracted.text, EMPTY_REPLY_FALLBACK), actorUserId: session.userId, ip });
      // WP-AI3 老闆 feedback（正式站助手）：安全 guard（DML/DDL/指示性
      // 文字）先行——`checkOutputGuardAndAudit()` 完全唔改，順序上永遠
      // 行喺表達方式 guard 之前，`applyOutputStyleGuard()` 淨係喺安全
      // guard 判斷之後嘅（可能已經換咗做標準回覆嘅）文字上面再做一層
      // 「業務用語化」，唔會削弱、亦都唔會繞過安全 guard。
      const styleResult = await applyOutputStyleGuard({ text: guardResult.text, llmClient, actorUserId: session.userId, ip });
      const finalText = styleResult.text;
      // 安全 guard triggered → 丟棄全部 actions；否則鎖月月份嘅寫入卡丟棄（只過濾 one_click_run／backfill_from_postorder）。
      const suggestedActions = guardResult.triggered ? [] : await dropLockedMonthActions(dropGuardedActions(extracted.actions));
      return {
        finalText,
        persist: () => appendConversationTurn(session.userId, parsed.message, finalText, suggestedActions),
        audit: {
          tableName: "ai_chat",
          rowId: session.userId,
          action: "ai_chat",
          after: {
            question: parsed.message,
            tools_used: result.toolsUsed,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            guard_triggered: guardResult.triggered,
            style_rewritten: styleResult.triggered,
            provider: result.provider ?? null,
            model: result.model ?? null,
            // 建議紀錄由呢度承擔（只存 type／label，唔存 params、唔存對話全文）
            suggested_actions: suggestedActions.map((a) => ({ type: a.type, label: a.label })),
          },
        },
        done: {
          text: finalText,
          tools_used: result.toolsUsed,
          guard_triggered: guardResult.triggered,
          style_rewritten: styleResult.triggered,
          // 老闆正式站驗收要求：token 用量之前淨係寫入 audit_log，
          // 前端/smoke script 攞唔到——LlmClient.chat() 早已經回埋
          // input_tokens/output_tokens（見 llm.ts LlmChatResult），
          // 呢度單純傳埋出嚟，唔涉及新查詢/新權限判斷。
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          provider: result.provider ?? null,
          model: result.model ?? null,
          suggested_actions: suggestedActions,
        },
      };
    },
    onError: ({ err, session }) => {
      // WP-AI-DIAG：應用層錯誤日誌（fire-and-forget、已遮罩；LlmUnavailableError 帶埋上游 HTTP status，方便診斷地區封鎖／key 問題）
      const upstream = err instanceof LlmUnavailableError && err.cause ? err.cause : err;
      const upstreamStatus = (upstream as { status?: unknown }).status;
      void writeAppErrorLog({
        status: typeof upstreamStatus === "number" ? upstreamStatus : err instanceof LlmUnavailableError ? 503 : 500,
        method: "POST",
        route: "/api/ai/chat",
        errorCode: err instanceof LlmUnavailableError ? "ai_provider_unavailable" : "internal_error",
        errorName: upstream instanceof Error ? upstream.constructor.name : typeof upstream,
        message: safeErrorSummary(upstream),
        actorUserId: session.userId,
      });
    },
  });
}
