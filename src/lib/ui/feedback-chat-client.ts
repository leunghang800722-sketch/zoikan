// P2.5「現場反映」開會模式——前端 API client。`POST /api/feedback/session/
// chat` 同 `/api/ai/chat` 一樣用 SSE（見 `ai-chat-client.ts` 嘅
// `streamAiChat()`），呢度另起一份（唔係加參數重用嗰個）——payload 形狀
// 唔同（多咗 `session_id`），endpoint 都唔同，分開兩個 client 令兩邊各自
// 獨立修改唔會互相影響。
import type { AiPageContext } from "./ai-context";
import { streamChatSse } from "./chat-stream";

interface FeedbackChatDoneResult {
  text: string;
  toolsUsed: string[];
  guardTriggered: boolean;
  feasibilityGuardTriggered: boolean;
}

export interface FeedbackChatStreamHandlers {
  onDelta?: (text: string) => void;
  onDone?: (result: FeedbackChatDoneResult) => void;
  onError?: (message: string) => void;
}

export async function streamFeedbackChat(
  sessionId: string,
  message: string,
  context: AiPageContext | undefined,
  handlers: FeedbackChatStreamHandlers,
): Promise<void> {
  return streamChatSse<FeedbackChatDoneResult>(
    "/api/feedback/session/chat",
    context ? { session_id: sessionId, message, context } : { session_id: sessionId, message },
    (data) => ({
      text: (data.text as string | undefined) ?? "",
      toolsUsed: (data.tools_used as string[] | undefined) ?? [],
      guardTriggered: !!data.guard_triggered,
      feasibilityGuardTriggered: !!data.feasibility_guard_triggered,
    }),
    handlers,
  );
}
