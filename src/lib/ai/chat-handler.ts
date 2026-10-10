// P3-5.3：兩條 chat route（`POST /api/ai/chat`、`POST /api/feedback/session/chat`）
// 共用嘅 SSE 骨架——session 驗證 → 每日額度 → body 校驗 → 各 route 自己嘅前置檢查
// → LlmClient → 歷史／工具 → 行 tool-use loop → 輸出 guard（各 route 自己決定
// 次序同種類）→ 切 chunk 送 `delta` → 存對話 → audit → `done`。
//
// 純重構：次序、錯誤 response、SSE 文字逐 byte 同拆出前一樣（`tests/
// p3-5-chat-sse.test.ts` 用舊碼錄低嘅 golden 比對）。每條 route 只剩差異：
// 驗證方式、前置檢查、prompt／history、輸出 guard、存儲、audit、done payload。
//
// 結構性保證（tests/ai-structural-guard.test.ts 掃 `src/lib/ai/**`）：呢個檔唔 import
// `@/lib/db`、唔寫 `prisma.`、唔 import 任何 route。
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { getClientIp } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { writeAudit, type AuditAction } from "@/lib/audit";
import { assertUnderDailyLimit } from "@/lib/ai-rate-limit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import { buildAiTools } from "@/lib/ai/tools";
import { getLlmClient, LlmUnavailableError, type LlmChatResult, type LlmClient, type LlmHistoryTurn } from "@/lib/ai/llm";

export const MAX_TOOL_ROUNDS = 8;
export const SSE_CHUNK_SIZE = 40;

/** 前端側欄由網址解析出嚟嘅頁面提示——純粹俾 prompt 用，唔係指令、唔經權限判斷（長度上限防濫用）。 */
export const ChatContextSchema = z
  .object({
    path: z.string().max(200).optional(),
    site_id: z.string().max(100).optional(),
    month: z.string().max(20).optional(),
    broker: z.string().max(100).optional(),
  })
  .strict()
  .optional();

export const ChatMessageSchema = z.string().min(1, "問題唔可以係空").max(4000, "問題太長（上限 4000 字符）");

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** ApiError → JSON error response；其他錯誤照拋。 */
export function apiErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) return jsonResponse(err.status, { error: err.code, message: err.message });
  throw err;
}

export function withEmptyReplyFallback(text: string, fallback: string): string {
  return text.trim() === "" ? fallback : text;
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export interface ChatFinalized {
  /** 過晒所有輸出 guard 之後、會切 chunk 送出同存落對話嘅最終文字。 */
  finalText: string;
  /** 送完 `delta` 之後、audit 之前執行（存對話 turn）。 */
  persist: () => Promise<unknown>;
  audit: { tableName: string; rowId: string; action: AuditAction; after: Record<string, unknown> };
  /** `done` event 嘅 payload（key 次序即 JSON 次序）。 */
  done: Record<string, unknown>;
}

export interface ChatRouteConfig<Parsed, Prep> {
  authorize: (req: Request) => Promise<AuthedSession>;
  bodySchema: z.ZodType<Parsed>;
  /** body 校驗之後、揀 LlmClient 之前嘅 route 專屬檢查；回 `{ response }` 即提早結束。 */
  prepare?: (args: { session: AuthedSession; parsed: Parsed }) => Promise<{ response: Response } | { prep: Prep }>;
  loadHistory: (args: { session: AuthedSession; parsed: Parsed; prep: Prep }) => Promise<Array<{ role: LlmHistoryTurn["role"]; content: string }>>;
  compose: (args: { session: AuthedSession; parsed: Parsed; prep: Prep }) => { systemPrompt: string; userMessage: string };
  finalize: (args: {
    session: AuthedSession;
    parsed: Parsed;
    prep: Prep;
    ip: string | null;
    llmClient: LlmClient;
    result: LlmChatResult;
  }) => Promise<ChatFinalized>;
  /** LLM／guard 出錯（SSE `error` event 之前）嘅副作用，例如寫應用層錯誤日誌。 */
  onError?: (args: { err: unknown; session: AuthedSession }) => void;
}

export async function handleChatRequest<Parsed, Prep = undefined>(req: Request, cfg: ChatRouteConfig<Parsed, Prep>): Promise<Response> {
  let session: AuthedSession;
  try {
    session = await cfg.authorize(req);
  } catch (err) {
    return apiErrorResponse(err);
  }

  const ip = getClientIp(req);

  // 同 `/api/ai/chat` 共用嘅每日額度（見 `src/lib/ai-rate-limit.ts` 頂註解），撞到上限就 429。
  const { used, limit } = await assertUnderDailyLimit(session.userId);
  if (used >= limit) {
    return jsonResponse(429, { error: "rate_limited", message: `今日已經問咗 ${used} 次，上限 ${limit} 次，聽日再嚟啦。` });
  }

  const bodyRaw = await readJson(req);
  let parsed: Parsed;
  try {
    parsed = parseBody(cfg.bodySchema, bodyRaw);
  } catch (err) {
    return apiErrorResponse(err);
  }

  let prep = undefined as Prep;
  if (cfg.prepare) {
    const prepared = await cfg.prepare({ session, parsed });
    if ("response" in prepared) return prepared.response;
    prep = prepared.prep;
  }

  let llmClient: LlmClient;
  try {
    llmClient = getLlmClient();
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      return jsonResponse(503, { error: "ai_provider_unavailable", message: err.message });
    }
    throw err;
  }

  const [fieldVisibility, historyRaw] = await Promise.all([computeFieldVisibility(session), cfg.loadHistory({ session, parsed, prep })]);
  const history: LlmHistoryTurn[] = historyRaw.map((m) => ({ role: m.role, content: m.content }));
  const tools = buildAiTools({ session, fieldVisibility });
  const { systemPrompt, userMessage } = cfg.compose({ session, parsed, prep });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await llmClient.chat({ systemPrompt, tools, history, userMessage, maxToolRounds: MAX_TOOL_ROUNDS });

        const fin = await cfg.finalize({ session, parsed, prep, ip, llmClient, result });

        for (const piece of chunk(fin.finalText, SSE_CHUNK_SIZE)) {
          controller.enqueue(encoder.encode(sseEvent("delta", { text: piece })));
        }

        await fin.persist();
        await writeAudit({
          actorUserId: session.userId,
          tableName: fin.audit.tableName,
          rowId: fin.audit.rowId,
          action: fin.audit.action,
          after: fin.audit.after,
          ip,
        });

        controller.enqueue(encoder.encode(sseEvent("done", fin.done)));
      } catch (err) {
        const message = err instanceof LlmUnavailableError ? err.message : "系統錯誤，請稍後再試";
        cfg.onError?.({ err, session });
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
