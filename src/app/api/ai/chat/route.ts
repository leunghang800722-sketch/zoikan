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
import { ApiError } from "@/lib/api/errors";
import { getClientIp } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { assertUnderDailyLimit } from "@/lib/ai-rate-limit";
import { getConversation, appendConversationTurn } from "@/lib/ai-conversation";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import { buildAiTools } from "@/lib/ai/tools";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { checkOutputGuardAndAudit } from "@/lib/ai/output-guard";
import { getLlmClient, LlmUnavailableError, type LlmHistoryTurn } from "@/lib/ai/llm";

// WP-AI2：`context` 由前端側欄由目前網址解析出嚟（更表頁嘅
// site_id/month、報表頁嘅 month），純粹係俾 system prompt 加一段提示
// （見 `buildSystemPrompt()`），**唔係指令、唔經任何驗證**——長度上限
// 純粹防濫用，值本身唔會拎去做任何權限/查詢判斷。
const ChatRequestSchema = z
  .object({
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
    session = await requirePermission(req, "助手", "view");
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

  const { used, limit } = await assertUnderDailyLimit(session.userId);
  if (used >= limit) {
    return new Response(
      JSON.stringify({ error: "rate_limited", message: `今日已經問咗 ${used} 次，上限 ${limit} 次，聽日再嚟啦。` }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

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

  const [fieldVisibility, historyRaw] = await Promise.all([computeFieldVisibility(session), getConversation(session.userId)]);
  const history: LlmHistoryTurn[] = historyRaw.map((m) => ({ role: m.role, content: m.content }));
  const tools = buildAiTools({ session, fieldVisibility });
  const systemPrompt = buildSystemPrompt(session, parsed.context);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await llmClient.chat({
          systemPrompt,
          tools,
          history,
          userMessage: parsed.message,
          maxToolRounds: MAX_TOOL_ROUNDS,
        });

        const guardResult = await checkOutputGuardAndAudit({ text: result.text, actorUserId: session.userId, ip });
        const finalText = guardResult.text;

        for (const piece of chunk(finalText, SSE_CHUNK_SIZE)) {
          controller.enqueue(encoder.encode(sseEvent("delta", { text: piece })));
        }

        await appendConversationTurn(session.userId, parsed.message, finalText);
        await writeAudit({
          actorUserId: session.userId,
          tableName: "ai_chat",
          rowId: session.userId,
          action: "ai_chat",
          after: {
            question: parsed.message,
            tools_used: result.toolsUsed,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            guard_triggered: guardResult.triggered,
          },
          ip,
        });

        controller.enqueue(
          encoder.encode(
            sseEvent("done", {
              text: finalText,
              tools_used: result.toolsUsed,
              guard_triggered: guardResult.triggered,
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
