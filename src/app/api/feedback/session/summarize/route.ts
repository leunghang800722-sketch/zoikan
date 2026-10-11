// P2.5「現場反映」開會模式——`POST /api/feedback/session/summarize`：
// 伺服器攞 transcript 叫模型按範本輸出 JSON fields＋組 markdown，回俾
// 前端預覽（**唔寫 feedback_reports**——真正寫入喺 `session/submit`，
// 用戶確認/編輯之後先寫，符合鐵律「AI 助手架構上做唔到任何寫入，寫入
// 一律由伺服器 code 喺用戶明確撳掣之後先做」）。
//
// P2.5 Opus 驗收應修④：呢度都真係叫 LLM，同 `/api/ai/chat`／
// `session/chat` **共用同一個每日額度**（`assertUnderDailyLimit()`）
// ——撞到上限 429。每次成功整理都寫一行 `ai_feedback_chat`/
// `ai_feedback_summarize` audit（唔止 guard 觸發先寫），等
// `countTodayAiChats()` 數得到（見 `src/lib/ai-rate-limit.ts`）。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { ApiError, NotFound, BadRequest } from "@/lib/api/errors";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { assertUnderDailyLimit, releaseDailySlot } from "@/lib/ai-rate-limit";
import { getSessionForUser, messagesOf, turnCountOf, type StoredFeedbackMessage } from "@/lib/feedback/session";
import { buildFeedbackSummarizePrompt } from "@/lib/ai/feedback-prompt";
import { checkOutputGuardAndAudit } from "@/lib/ai/output-guard";
import { checkFeasibilityGuardAndAudit } from "@/lib/ai/feasibility-guard";
import { getLlmClient, LlmUnavailableError } from "@/lib/ai/llm";
import { todayLocalStr } from "@/lib/ui/format";
import {
  EDITABLE_FIELD_KEYS,
  FEEDBACK_FOOTER,
  buildReporterLine,
  buildSummaryMarkdown,
  lastNTurns,
  type EditableFields,
  type FeedbackFields,
} from "@/lib/feedback/report";

const SummarizeRequestSchema = z.object({ session_id: z.string().min(1) }).strict();

function transcriptToText(messages: StoredFeedbackMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "用戶" : "訪談員"}：${m.content}`).join("\n");
}

function parseSummaryJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  // 保底：即使 prompt 明文要求冇 code fence，模型有時仍然會包一層
  // ```json ... ```，呢度容忍咗先至 JSON.parse。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1]!.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(502, "summarize_failed", "整理失敗，請重試一次");
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    const ip = getClientIp(req);
    const body = await readJson(req);
    const parsed = parseBody(SummarizeRequestSchema, body);

    const feedbackSession = await getSessionForUser(parsed.session_id, session.userId);
    if (!feedbackSession || feedbackSession.status !== "draft") throw NotFound("呢個開會 session 唔存在或者已經結束");
    if (turnCountOf(feedbackSession) < 1) throw BadRequest("最少要傾一輪先可以整理");

    // P2.5 Opus 驗收應修④：同 `/api/ai/chat`／`session/chat` 共用嘅每日
    // 額度（見 `src/lib/ai-rate-limit.ts` 頂註解）。
    const { used, limit } = await assertUnderDailyLimit(session.userId);
    if (used >= limit) {
      throw new ApiError(429, "rate_limited", `今日已經問咗 ${used} 次，上限 ${limit} 次，聽日再嚟啦。`);
    }

    let llmClient;
    try {
      llmClient = getLlmClient();
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        await releaseDailySlot(session.userId);
        throw new ApiError(503, "ai_provider_unavailable", err.message);
      }
      throw err;
    }

    const transcript = lastNTurns(messagesOf(feedbackSession), 20);
    const result = await llmClient.chat({
      systemPrompt: buildFeedbackSummarizePrompt(),
      tools: [],
      history: [],
      userMessage: transcriptToText(transcript),
      maxToolRounds: 1,
    });

    const rawFields = parseSummaryJson(result.text);

    // 逐欄過兩層 guard（安全 guard 先，可行性 guard 後）——局部換字，
    // 唔會因為一欄觸發就成份摘要變晒標準句。
    const editable: EditableFields = {} as EditableFields;
    for (const key of EDITABLE_FIELD_KEYS) {
      const raw = typeof rawFields[key] === "string" ? (rawFields[key] as string) : "";
      const guarded = await checkOutputGuardAndAudit({ text: raw, actorUserId: session.userId, ip });
      const feasibility = await checkFeasibilityGuardAndAudit({
        text: guarded.text,
        actorUserId: session.userId,
        sessionId: feedbackSession.id,
        ip,
      });
      editable[key] = feasibility.text;
    }

    const fields: FeedbackFields = {
      ...editable,
      reporter: buildReporterLine({
        name: session.name,
        roleName: session.roleName,
        dateStr: todayLocalStr(),
        path: (feedbackSession.pageContext as { path?: string } | null)?.path,
      }),
      footer: FEEDBACK_FOOTER,
    };
    const summaryMd = buildSummaryMarkdown(fields);

    // P2.5 Opus 驗收應修④：每次成功整理（叫咗一次 LLM）都寫一行
    // audit——唔淨係 guard 觸發先寫，等
    // `countTodayAiChats()`／`assertUnderDailyLimit()` 數得到（見
    // `src/lib/ai-rate-limit.ts` 嘅 `AI_QUOTA_ACTIONS`）。
    await writeAudit({
      actorUserId: session.userId,
      tableName: "ai_feedback_chat",
      rowId: feedbackSession.id,
      action: "ai_feedback_summarize",
      after: { session_id: feedbackSession.id, input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      ip,
    });

    return ok(brandSafeResponse({ fields, summary_md: summaryMd }));
  });
}
