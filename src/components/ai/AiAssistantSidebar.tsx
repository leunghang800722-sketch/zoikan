"use client";
// WP-AI2：全站右邊緣「在勤助手」直向 tab＋側欄——`(app)/layout.tsx` 淨係
// 喺 `助手:view` 為 true 先會 render 呢個 component（見 layout.tsx 註
// 解），所以呢度內部唔使再做多一次權限判斷——雞頭／安員嗰邊連呢個
// component 都唔會出現喺 DOM（唔係淨係 CSS 隱藏）。
//
// UI 只經 API（硬規則）：問答經 `streamAiChat()`（`@/lib/ui/ai-chat-client`
// POST /api/ai/chat SSE），對話記錄經 `GET`/`DELETE /api/ai/conversation`
// （`api-client.ts`）。
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiRequest } from "@/lib/ui/api-client";
import { deriveAiContext, type AiPageContext } from "@/lib/ui/ai-context";
import { streamAiChat, type AiChatMessage } from "@/lib/ui/ai-chat-client";
import { SimpleMarkdown } from "./SimpleMarkdown";

// 刻意唔用 next/navigation 嘅 `useSearchParams()`——呢個 component 掛喺
// `(app)/layout.tsx`，包住全站每一頁，用 `useSearchParams()` 會逼成個
// layout（連埋底下所有頁面）都要包一層 Suspense boundary（同
// `RosterEditor.tsx` 避開呢個做法嘅理由一致，見嗰邊註解）。改喺真係要
// 送問題嗰一刻先讀 `window.location`——反而更準（一定係用戶撳「送出」
// 嗰刻嘅真實網址，唔會有 stale closure 問題）。
function getCurrentAiContext(): AiPageContext {
  if (typeof window === "undefined") return { path: "/" };
  return deriveAiContext(window.location.pathname, new URLSearchParams(window.location.search));
}

const OPEN_STORAGE_KEY = "zoikan-ai-panel-open";
const WIDTH_STORAGE_KEY = "zoikan-ai-panel-width";
const NARROW_WIDTH = 380;
const WIDE_WIDTH = 560;
const MOBILE_BREAKPOINT_PX = 768;

const EXAMPLE_QUESTIONS = ["呢個盤今個月排咗幾多人？", "7 月毛利點解係咁？", "呢張價卡出街價點解係咁？", "點樣開新月份更表？"];

function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    const n = raw ? Number(raw) : NARROW_WIDTH;
    return n === WIDE_WIDTH ? WIDE_WIDTH : NARROW_WIDTH;
  } catch {
    return NARROW_WIDTH;
  }
}

export function AiAssistantSidebar({ userName }: { userName: string }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(NARROW_WIDTH);
  const [isMobile, setIsMobile] = useState(false);

  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const tabButtonRef = useRef<HTMLButtonElement>(null);

  // 首次掛載先讀 localStorage／偵測手機闊度——喺 client component 但
  // SSR 都會跑一次 render，讀 window 要留喺 effect 入面，避免 hydration
  // 唔對版。
  useEffect(() => {
    setOpen(readStoredOpen());
    setWidth(readStoredWidth());
    setMounted(true);
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch {
      // localStorage 唔到就靜靜哋放棄記住呢個偏好，唔影響開關功能本身
    }
  }, [mounted, open]);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // 同上
    }
  }, [mounted, width]);

  const loadConversation = useCallback(async () => {
    setLoadingHistory(true);
    const res = await apiGet<{ messages: AiChatMessage[] }>("/api/ai/conversation");
    setLoadingHistory(false);
    if (res.ok) setMessages(res.data.messages);
  }, []);

  useEffect(() => {
    if (open) void loadConversation();
  }, [open, loadConversation]);

  // Esc 關閉。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      textareaRef.current?.focus();
    } else {
      tabButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight });
  }, [messages, streamingText]);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      setErrorMessage(null);
      setInputValue("");
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setSending(true);
      setStreamingText("");

      await streamAiChat(text, getCurrentAiContext(), {
        onDelta: (chunk) => setStreamingText((prev) => (prev ?? "") + chunk),
        onDone: async () => {
          setSending(false);
          setStreamingText(null);
          await loadConversation();
        },
        onError: (msg) => {
          setSending(false);
          setStreamingText(null);
          setErrorMessage(msg);
        },
      });
    },
    [sending, loadConversation],
  );

  const handleClear = useCallback(async () => {
    const res = await apiRequest("/api/ai/conversation", { method: "DELETE" });
    if (res.ok) {
      setMessages([]);
      setErrorMessage(null);
    }
    setConfirmingClear(false);
  }, []);

  const toggleWidth = useCallback(() => {
    setWidth((w) => (w >= WIDE_WIDTH ? NARROW_WIDTH : WIDE_WIDTH));
  }, []);

  const showWelcome = messages.length === 0 && !sending && !loadingHistory;

  return (
    <>
      {!open && (
        <button
          ref={tabButtonRef}
          type="button"
          data-testid="ai-assistant-tab"
          aria-label="開啟在勤助手"
          onClick={() => setOpen(true)}
          className="fixed right-0 top-1/2 z-30 -translate-y-1/2 rounded-l-md border border-r-0 border-gray-300 bg-white px-2 py-4 text-sm font-medium tracking-wide text-gray-700 shadow-md hover:bg-gray-50"
          style={{ writingMode: "vertical-rl" }}
        >
          在勤助手
        </button>
      )}

      {open && (
        <div
          role="complementary"
          aria-label="在勤助手側欄"
          data-testid="ai-assistant-panel"
          className={
            isMobile
              ? "fixed inset-0 z-40 flex flex-col bg-white"
              : "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-gray-200 bg-white shadow-xl"
          }
          style={isMobile ? undefined : { width }}
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900">在勤助手</h2>
            <div className="flex items-center gap-1">
              {!isMobile && (
                <button
                  type="button"
                  onClick={toggleWidth}
                  aria-label={width >= WIDE_WIDTH ? "縮窄側欄" : "擴闊側欄"}
                  className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                >
                  {width >= WIDE_WIDTH ? "窄" : "闊"}
                </button>
              )}
              <button
                type="button"
                data-testid="ai-clear-conversation"
                onClick={() => setConfirmingClear(true)}
                className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
              >
                清空對話
              </button>
              <button
                type="button"
                aria-label="關閉在勤助手"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                關閉
              </button>
            </div>
          </div>

          {confirmingClear && (
            <div className="flex items-center justify-between gap-2 border-b border-yellow-200 bg-yellow-50 px-4 py-2 text-xs text-yellow-800">
              <span>確定清空成個對話記錄？呢個動作唔可以復原。</span>
              <div className="flex shrink-0 gap-2">
                <button type="button" data-testid="ai-clear-confirm" onClick={handleClear} className="rounded bg-yellow-600 px-2 py-1 text-white">
                  確定清空
                </button>
                <button type="button" onClick={() => setConfirmingClear(false)} className="rounded border border-yellow-300 px-2 py-1 text-yellow-800">
                  取消
                </button>
              </div>
            </div>
          )}

          <div ref={messageListRef} data-testid="ai-message-list" className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {showWelcome && (
              <div className="space-y-3" data-testid="ai-welcome">
                <p className="text-sm text-gray-700">你好，{userName}，今日想問啲咩？</p>
                <div className="flex flex-col gap-2">
                  {EXAMPLE_QUESTIONS.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      data-testid="ai-example-button"
                      onClick={() => handleSubmit(ex)}
                      className="rounded border border-gray-200 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  data-testid={m.role === "user" ? "ai-message-user" : "ai-message-assistant"}
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-lg bg-blue-600 px-3 py-2 text-sm text-white"
                      : "max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-900"
                  }
                >
                  {m.role === "assistant" ? <SimpleMarkdown text={m.content} /> : <span className="whitespace-pre-wrap">{m.content}</span>}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div data-testid="ai-thinking" className="max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
                  {streamingText ? <span className="whitespace-pre-wrap">{streamingText}</span> : "思考緊…"}
                </div>
              </div>
            )}

            {errorMessage && (
              <div data-testid="ai-error" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit(inputValue);
            }}
            className="flex items-end gap-2 border-t border-gray-200 p-3"
          >
            <textarea
              ref={textareaRef}
              data-testid="ai-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit(inputValue);
                }
              }}
              rows={2}
              placeholder="問啲咩？（Enter 送出，Shift+Enter 換行）"
              aria-label="輸入問題"
              disabled={sending}
              className="flex-1 resize-none rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none disabled:bg-gray-50"
            />
            <button
              type="submit"
              data-testid="ai-submit"
              disabled={sending || !inputValue.trim()}
              aria-label="送出"
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              送出
            </button>
          </form>
        </div>
      )}
    </>
  );
}
