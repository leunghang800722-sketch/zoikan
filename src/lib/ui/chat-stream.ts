// P3-5.3：側欄 AI 助手（`streamAiChat`）同開會模式（`streamFeedbackChat`）共用嘅 SSE client
// ——兩邊 endpoint／payload／done 形狀唔同，其餘（fetch、友善錯誤文字、reader 逐個
// `event: xxx\ndata: {...}\n\n` block 解析）完全一樣，抽到呢度。
//
// `apiRequest()`（`api-client.ts`）淨係識 `res.json()`，用唔到，所以自己攞 `res.body` 個 reader。

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

export interface ChatStreamHandlers<TDone> {
  onDelta?: (text: string) => void;
  onDone?: (result: TDone) => void;
  onError?: (message: string) => void;
}

/** `mapDone`：把 `done` event 嘅 snake_case payload 轉做前端用嘅 camelCase 結果。 */
export async function streamChatSse<TDone>(
  url: string,
  payload: unknown,
  mapDone: (data: Record<string, unknown>) => TDone,
  handlers: ChatStreamHandlers<TDone>,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
        else if (parsed.event === "done") handlers.onDone?.(mapDone(data));
        else if (parsed.event === "error") handlers.onError?.(data.message ?? "發生錯誤，請稍後再試");
      } catch {
        // 忽略單個解析唔到嘅 SSE block，唔中斷成個串流
      }
    }
  }
}
