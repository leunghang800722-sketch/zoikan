// P2.5「現場反映」開會模式——前端 API client。`POST /api/feedback/session/
// chat` 同 `/api/ai/chat` 一樣用 SSE（見 `ai-chat-client.ts` 嘅
// `streamAiChat()`），呢度另起一份（唔係加參數重用嗰個）——payload 形狀
// 唔同（多咗 `session_id`），endpoint 都唔同，分開兩個 client 令兩邊各自
// 獨立修改唔會互相影響。
import type { AiPageContext } from "./ai-context";
import { friendlyAiError } from "./ai-chat-client";

export interface FeedbackChatDoneResult {
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

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split("\n");
  const eventLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  if (!eventLine || !dataLine) return null;
  return { event: eventLine.slice("event: ".length), data: dataLine.slice("data: ".length) };
}

export async function streamFeedbackChat(
  sessionId: string,
  message: string,
  context: AiPageContext | undefined,
  handlers: FeedbackChatStreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/feedback/session/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context ? { session_id: sessionId, message, context } : { session_id: sessionId, message }),
    });
  } catch {
    handlers.onError?.("網絡錯誤，請檢查連線後重試");
    return;
  }

  if (!res.ok) {
    let body: { message?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    handlers.onError?.(friendlyAiError(res.status, body.message));
    return;
  }

  if (!res.body) {
    handlers.onError?.("網絡錯誤，請檢查連線後重試");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const raw of blocks) {
      const parsed = parseSseBlock(raw);
      if (!parsed) continue;
      try {
        const data = JSON.parse(parsed.data);
        if (parsed.event === "delta") handlers.onDelta?.(data.text ?? "");
        else if (parsed.event === "done")
          handlers.onDone?.({
            text: data.text ?? "",
            toolsUsed: data.tools_used ?? [],
            guardTriggered: !!data.guard_triggered,
            feasibilityGuardTriggered: !!data.feasibility_guard_triggered,
          });
        else if (parsed.event === "error") handlers.onError?.(data.message ?? "發生錯誤，請稍後再試");
      } catch {
        // 忽略單個解析唔到嘅 SSE block
      }
    }
  }
}
