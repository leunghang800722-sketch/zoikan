// WP-AI2：側欄 AI 助手前端——`POST /api/ai/chat` 用 SSE 傳輸（見
// `src/app/api/ai/chat/route.ts`），`apiRequest()`（`api-client.ts`）淨係
// 識 `res.json()`，用唔到，所以呢度自己攞 `res.body` 個 reader 逐個
// SSE event（`event: xxx\ndata: {...}\n\n`）解返出嚟——共用實作喺 `chat-stream.ts`（P3-5.3）。
import type { AiPageContext } from "./ai-context";
import { streamChatSse, friendlyAiError } from "./chat-stream";

export { friendlyAiError };

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  /** WP-AI-DIAG（additive）：assistant 訊息嘅建議動作卡（前端用 `sanitizeActionCards()` 再驗一次）。 */
  actions?: unknown[];
}

interface AiChatDoneResult {
  text: string;
  toolsUsed: string[];
  guardTriggered: boolean;
}

export interface AiChatStreamHandlers {
  onDelta?: (text: string) => void;
  onDone?: (result: AiChatDoneResult) => void;
  onError?: (message: string) => void;
}

export async function streamAiChat(message: string, context: AiPageContext | undefined, handlers: AiChatStreamHandlers): Promise<void> {
  return streamChatSse<AiChatDoneResult>(
    "/api/ai/chat",
    context ? { message, context } : { message },
    (data) => ({ text: (data.text as string | undefined) ?? "", toolsUsed: (data.tools_used as string[] | undefined) ?? [], guardTriggered: !!data.guard_triggered }),
    handlers,
  );
}
