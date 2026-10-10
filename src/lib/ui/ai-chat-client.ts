// WP-AI2：側欄 AI 助手前端——`POST /api/ai/chat` 用 SSE 傳輸（見
// `src/app/api/ai/chat/route.ts`），`apiRequest()`（`api-client.ts`）淨係
// 識 `res.json()`，用唔到，所以呢度自己攞 `res.body` 個 reader 逐個
// SSE event（`event: xxx\ndata: {...}\n\n`）解返出嚟。
import type { AiPageContext } from "./ai-context";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  /** WP-AI-DIAG（additive）：assistant 訊息嘅建議動作卡（前端用 `sanitizeActionCards()` 再驗一次）。 */
  actions?: unknown[];
}

export interface AiChatDoneResult {
  text: string;
  toolsUsed: string[];
  guardTriggered: boolean;
}

export interface AiChatStreamHandlers {
  onDelta?: (text: string) => void;
  onDone?: (result: AiChatDoneResult) => void;
  onError?: (message: string) => void;
}

// 對應 docs/ai-assistant.md／WP-AI2 任務指示要求嘅友善文字。
const FRIENDLY_ERROR_BY_STATUS: Record<number, string> = {
  401: "登入已過期，請重新登入。",
  403: "你冇權限使用在勤助手。",
  429: "今日已達提問上限，聽日再嚟啦。",
  503: "助手暫時未連接到 AI 服務，請稍後再試。",
};

export function friendlyAiError(status: number, fallbackMessage?: string): string {
  return FRIENDLY_ERROR_BY_STATUS[status] ?? fallbackMessage ?? "發生錯誤，請稍後再試";
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split("\n");
  const eventLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  if (!eventLine || !dataLine) return null;
  return { event: eventLine.slice("event: ".length), data: dataLine.slice("data: ".length) };
}

export async function streamAiChat(message: string, context: AiPageContext | undefined, handlers: AiChatStreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context ? { message, context } : { message }),
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
      // ignore：冇 body 就用 fallback 文字
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
          handlers.onDone?.({ text: data.text ?? "", toolsUsed: data.tools_used ?? [], guardTriggered: !!data.guard_triggered });
        else if (parsed.event === "error") handlers.onError?.(data.message ?? "發生錯誤，請稍後再試");
      } catch {
        // 忽略單個解析唔到嘅 SSE block，唔中斷成個串流
      }
    }
  }
}
