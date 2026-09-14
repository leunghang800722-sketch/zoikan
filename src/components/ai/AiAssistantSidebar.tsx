"use client";
// WP-AI2：全站右邊緣「在勤助手」直向 tab＋側欄——`(app)/layout.tsx` 淨係
// 喺 `助手:view` 為 true 先會 render 呢個 component（見 layout.tsx 註
// 解），所以呢度內部唔使再做多一次權限判斷——雞頭／安員嗰邊連呢個
// component 都唔會出現喺 DOM（唔係淨係 CSS 隱藏）。
//
// UI 只經 API（硬規則）：問答經 `streamAiChat()`（`@/lib/ui/ai-chat-client`
// POST /api/ai/chat SSE），對話記錄經 `GET`/`DELETE /api/ai/conversation`
// （`api-client.ts`）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiGet, apiPost, apiRequest } from "@/lib/ui/api-client";
import { deriveAiContext, type AiPageContext } from "@/lib/ui/ai-context";
import { streamAiChat, type AiChatMessage } from "@/lib/ui/ai-chat-client";
import { streamFeedbackChat } from "@/lib/ui/feedback-chat-client";
import { SimpleMarkdown } from "./SimpleMarkdown";
import { Notice } from "@/components/ui/Notice";

// P2.5「現場反映」開會模式（老闆 2026-09-15 拍板方案 D）——側欄獨立模式：
// 助手做訪談員，唔評可行性，討論存 `feedback_sessions`；撳「整理並送出」
// 攞返伺服器生成嘅範本預覽，用戶確認/編輯之後先由伺服器寫入
// `feedback_reports`（唔係模型工具）。呢個 component 已經淨係喺
// `助手:view` 為 true 先會 render（見檔案頂註解），所以老闆/主管/會計
// 都見到「開會反映」掣。
interface FeedbackFields {
  title: string;
  reporter: string;
  current_problem: string;
  desired_change: string;
  reason: string;
  related: string;
  open_questions: string;
  footer: string;
}
type EditableFeedbackKey = "title" | "current_problem" | "desired_change" | "reason" | "related" | "open_questions";
const EDITABLE_FEEDBACK_FIELDS: { key: EditableFeedbackKey; label: string }[] = [
  { key: "title", label: "標題" },
  { key: "current_problem", label: "現況／問題" },
  { key: "desired_change", label: "想點改" },
  { key: "reason", label: "點解（業務原因／影響）" },
  { key: "related", label: "相關盤／雞頭／月份／角色" },
  { key: "open_questions", label: "未確定嘅地方" },
];

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
// R1 驗收修正：外殼斷點由 `md`（768）改 `lg`（1024，見 `MobileNav.tsx`／
// `DesktopNav.tsx`），呢度判斷手機／桌面版（直向 tab vs FAB、side panel
// vs 全螢幕）都要跟——否則 768–1023px 呢段會出現「外殼已經係手機版
// （漢堡＋抽屜），但助手仲以為自己係桌面版」嘅唔一致。
const MOBILE_BREAKPOINT_PX = 1024;

// P2-C：建議 chips 文案跟返 README §19／24 嘅示例（「今日邊個盤未夠
// 人」「7 月毛利率最低 5 個盤」），第三句 README 原文寫「B07 本月幾多
// RD」——但 B07 係內部雞頭代號，鐵律「真名/工號/內部代號唔入 code」，
// 改用通用講法「公司兵」（`kind='internal'` 嗰批雞頭嘅統稱，唔係某個
// 特定代號）。
const EXAMPLE_QUESTIONS = ["今日邊個盤未夠人", "7 月毛利率最低 5 個盤", "公司兵本月幾多 RD"];

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

  // P2.5「現場反映」開會模式——狀態同普通問答模式分開擺（唔混用
  // messages/sending 等），兩套 UI 互斥顯示（`meetingMode` 決定顯示邊套）。
  const [meetingMode, setMeetingMode] = useState(false);
  const [meetingSessionId, setMeetingSessionId] = useState<string | null>(null);
  const [meetingMessages, setMeetingMessages] = useState<AiChatMessage[]>([]);
  const [meetingInput, setMeetingInput] = useState("");
  const [meetingSending, setMeetingSending] = useState(false);
  const [meetingStreamingText, setMeetingStreamingText] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [meetingStarting, setMeetingStarting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [preview, setPreview] = useState<FeedbackFields | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [meetingToast, setMeetingToast] = useState<string | null>(null);
  const meetingTurnCount = Math.floor(meetingMessages.length / 2);

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

  // P2 整合驗收②：桌面（≥1024）面板開住時，Opus 驗收發現面板以前純粹用
  // `fixed` 疊喺內容之上（overlay），會遮住更表右上「儲存／還原／匯出／
  // 複製上月」——README 要求嘅係「面板開時主內容縮窄」，唔係遮住。做法：
  // 面板開／關（連埋闊／窄切換）就喺 `<html>` set `data-ai-panel="open"`
  // ＋ CSS 變數 `--zk-ai-panel-w`（實際面板闊度 px），`globals.css` 見到
  // 呢個屬性就用 `padding-right` 幫 `<main>` 讓返位（見 globals.css「AI
  // 面板讓位」一段）。手機（<1024）維持全屏 overlay，唔使讓位，所以
  // `isMobile` 時唔 set。用 `useLayoutEffect`（唔係 `useEffect`）—— 連同
  // 上面讀 localStorage 嗰個 effect 一齊喺瀏覽器畫呢一幀之前盡快 set 好，
  // 減少「先閃一下冇縮窄，先至縮窄」嘅畫面跳動（「初始由 localStorage
  // 讀狀態時亦要 set，避免閃動」）。
  useLayoutEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (open && !isMobile) {
      root.setAttribute("data-ai-panel", "open");
      root.style.setProperty("--zk-ai-panel-w", `${width}px`);
    } else {
      root.removeAttribute("data-ai-panel");
      root.style.removeProperty("--zk-ai-panel-w");
    }
    return () => {
      root.removeAttribute("data-ai-panel");
      root.style.removeProperty("--zk-ai-panel-w");
    };
  }, [mounted, open, isMobile, width]);

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
  }, [messages, streamingText, meetingMessages, meetingStreamingText]);

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

  // P2.5「開會反映」——撳掣開／續 draft session（一個用戶同時最多一個
  // draft，見 `getOrCreateDraftSession()`），跟住切去開會模式 UI。
  const handleStartMeeting = useCallback(async () => {
    setMeetingStarting(true);
    setMeetingError(null);
    const context = getCurrentAiContext();
    const res = await apiPost<{ id: string; status: string; messages: AiChatMessage[] }>("/api/feedback/session", {
      page_context: context,
    });
    setMeetingStarting(false);
    if (!res.ok) {
      setErrorMessage(res.message);
      return;
    }
    setMeetingSessionId(res.data.id);
    setMeetingMessages(res.data.messages);
    setPreview(null);
    setMeetingMode(true);
  }, []);

  const handleMeetingSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || meetingSending || !meetingSessionId) return;
      setMeetingError(null);
      setMeetingInput("");
      setMeetingMessages((prev) => [...prev, { role: "user", content: text }]);
      setMeetingSending(true);
      setMeetingStreamingText("");

      await streamFeedbackChat(meetingSessionId, text, getCurrentAiContext(), {
        onDelta: (chunk) => setMeetingStreamingText((prev) => (prev ?? "") + chunk),
        onDone: (result) => {
          setMeetingSending(false);
          setMeetingStreamingText(null);
          setMeetingMessages((prev) => [...prev, { role: "assistant", content: result.text }]);
        },
        onError: (msg) => {
          setMeetingSending(false);
          setMeetingStreamingText(null);
          setMeetingError(msg);
        },
      });
    },
    [meetingSending, meetingSessionId],
  );

  const handleSummarize = useCallback(async () => {
    if (!meetingSessionId) return;
    setSummarizing(true);
    setMeetingError(null);
    const res = await apiPost<{ fields: FeedbackFields; summary_md: string }>("/api/feedback/session/summarize", {
      session_id: meetingSessionId,
    });
    setSummarizing(false);
    if (!res.ok) {
      setMeetingError(res.message);
      return;
    }
    setPreview(res.data.fields);
  }, [meetingSessionId]);

  const handlePreviewFieldChange = useCallback((key: EditableFeedbackKey, value: string) => {
    setPreview((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const resetMeetingState = useCallback(() => {
    setMeetingMode(false);
    setMeetingSessionId(null);
    setMeetingMessages([]);
    setMeetingInput("");
    setMeetingStreamingText(null);
    setMeetingError(null);
    setPreview(null);
  }, []);

  const handleConfirmSubmit = useCallback(async () => {
    if (!meetingSessionId || !preview) return;
    setSubmitting(true);
    setMeetingError(null);
    const fields = {
      title: preview.title,
      current_problem: preview.current_problem,
      desired_change: preview.desired_change,
      reason: preview.reason,
      related: preview.related,
      open_questions: preview.open_questions,
    };
    const res = await apiPost("/api/feedback/session/submit", { session_id: meetingSessionId, fields });
    setSubmitting(false);
    if (!res.ok) {
      setMeetingError(res.message);
      return;
    }
    resetMeetingState();
    setMeetingToast("已送出俾老闆");
    window.setTimeout(() => setMeetingToast(null), 4000);
  }, [meetingSessionId, preview, resetMeetingState]);

  const handleCancelMeeting = useCallback(async () => {
    if (meetingSessionId) {
      await apiPost("/api/feedback/session/abandon", { session_id: meetingSessionId });
    }
    resetMeetingState();
  }, [meetingSessionId, resetMeetingState]);

  const showWelcome = messages.length === 0 && !sending && !loadingHistory;

  // 老闆手機版 bug（2026-09-13）：呢個 tab／側欄一定要貼實螢幕最右邊
  // 緣，唔可以被任何祖先嘅 transform／overflow 影響 `position: fixed`
  // 嘅定位基準——直接 portal 去 `document.body`，唔理呢個 component
  // 本身掛喺 DOM 樹邊度（`(app)/layout.tsx` 嘅 `<main>` 有
  // `overflow-x-auto`），從根本上避免呢類定位失效。SSR／首次 client
  // render 之前 `document` 未存在，所以 `mounted` 之前淨係 render null
  // （同原有讀 localStorage 嘅 mount pattern 一致，唔會 hydration
  // mismatch）。
  const content = (
    <>
      {!open && (
        <>
          {/* 桌面（md+）：右邊緣直向 tab */}
          <button
            ref={tabButtonRef}
            type="button"
            data-testid="ai-assistant-tab"
            aria-label="開啟在勤助手"
            onClick={() => setOpen(true)}
            className="fixed right-0 top-[120px] z-30 hidden rounded-l-md bg-[#0f172a] px-[7px] py-3 text-xs tracking-[.1em] text-white shadow-md hover:bg-[#1e293b] lg:block"
            style={{ writingMode: "vertical-rl" }}
          >
            在勤助手
          </button>
          {/* 手機（<md）：右下角圓形浮動掣（老闆 2026-09-13：垂直置中嘅 tab 會壓住卡片） */}
          <button
            type="button"
            data-testid="ai-assistant-fab"
            aria-label="開啟在勤助手"
            onClick={() => setOpen(true)}
            className="fixed right-4 bottom-6 z-30 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[#0f172a] text-xs font-semibold text-white shadow-[0_6px_18px_rgba(15,23,42,.3)] lg:hidden"
          >
            助手
          </button>
        </>
      )}

      {open && (
        <div
          role="complementary"
          aria-label="在勤助手側欄"
          data-testid="ai-assistant-panel"
          className={
            isMobile
              ? "fixed inset-0 z-40 flex flex-col bg-white"
              : "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-zk-border bg-white shadow-xl"
          }
          style={isMobile ? undefined : { width }}
        >
          <div data-testid="ai-assistant-header" className="flex items-center gap-2 border-b border-zk-border px-4 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-zk-primary" />
            {/* P2 整合驗收⑤（Opus 驗收）：之前呢度仲有一句常駐嘅「只讀 ·
                答數據問題」副標，窄版（側欄預設 380px 闊）連同右邊四個
                掣（開會反映／窄闊/清空/關閉）成日逼到斷行，令頂欄高過
                一行。副標本身唔係關鍵資訊——收埋做 `title`（hover
                tooltip），唔再佔用 flex row 嘅橫向空間。 */}
            <h2
              className="truncate text-sm font-semibold text-zk-text"
              title={meetingMode ? undefined : "只讀 · 答數據問題"}
            >
              {meetingMode ? "在勤助手 · 開會反映" : "在勤助手"}
            </h2>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!meetingMode && (
                <button
                  type="button"
                  data-testid="ai-feedback-start"
                  onClick={handleStartMeeting}
                  disabled={meetingStarting}
                  title="開會反映——同助手講清楚想反映嘅現場問題／改動訴求"
                  className="rounded px-1.5 py-1 text-[11px] text-zk-muted hover:bg-zk-surface disabled:opacity-50"
                >
                  {meetingStarting ? "開緊…" : "開會反映"}
                </button>
              )}
              {!isMobile && !meetingMode && (
                <button
                  type="button"
                  onClick={toggleWidth}
                  aria-label={width >= WIDE_WIDTH ? "縮窄側欄" : "擴闊側欄"}
                  className="rounded px-1.5 py-1 text-[11px] text-zk-muted hover:bg-zk-surface"
                >
                  {width >= WIDE_WIDTH ? "窄" : "闊"}
                </button>
              )}
              {!meetingMode && (
                <button
                  type="button"
                  data-testid="ai-clear-conversation"
                  onClick={() => setConfirmingClear(true)}
                  className="rounded px-1.5 py-1 text-[11px] text-zk-muted hover:bg-zk-surface"
                >
                  清空
                </button>
              )}
              <button
                type="button"
                aria-label="關閉在勤助手"
                onClick={() => setOpen(false)}
                className="rounded px-1.5 py-1 text-[11px] text-zk-muted hover:bg-zk-surface"
              >
                關閉
              </button>
            </div>
          </div>

          {!meetingMode && confirmingClear && (
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

          {meetingMode && (
            <div data-testid="ai-feedback-mode" className="px-4 pt-3">
              <Notice variant="info">開會模式——講清楚你想改乜同點解，助手會問清楚再幫你整理；唔好打電話／銀行資料。</Notice>
            </div>
          )}

          {meetingMode ? (
            preview ? (
              <div data-testid="ai-feedback-preview" className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-zk-faint">提出人（唔可以改）</div>
                  <div className="rounded-md border border-zk-border bg-zk-surface px-3 py-2 text-[13px] text-zk-text-secondary">{preview.reporter}</div>
                </div>
                {EDITABLE_FEEDBACK_FIELDS.map(({ key, label }) => (
                  <div key={key} className="space-y-1">
                    <div className="text-[11px] font-semibold text-zk-faint">{label}</div>
                    <textarea
                      data-testid={`ai-feedback-field-${key}`}
                      value={preview[key]}
                      onChange={(e) => handlePreviewFieldChange(key, e.target.value)}
                      rows={key === "title" ? 1 : 3}
                      className="w-full resize-none rounded-md border border-zk-input-border px-2.5 py-2 text-[13px] focus:border-zk-primary focus:outline-none"
                    />
                  </div>
                ))}
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-zk-faint">（唔可以改）</div>
                  <div className="rounded-md border border-zk-border bg-zk-surface px-3 py-2 text-[12px] text-zk-muted">{preview.footer}</div>
                </div>
                {meetingError && (
                  <div data-testid="ai-error" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {meetingError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    data-testid="ai-feedback-submit"
                    onClick={handleConfirmSubmit}
                    disabled={submitting}
                    className="flex-1 rounded-md bg-zk-primary px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {submitting ? "送出緊…" : "確認送出"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="rounded-md border border-zk-border px-3 py-2 text-[13px] text-zk-text-secondary hover:bg-zk-surface"
                  >
                    返回對話
                  </button>
                </div>
              </div>
            ) : (
              <div
                ref={messageListRef}
                data-testid="ai-message-list"
                className={`flex-1 space-y-3 overflow-y-auto ${isMobile ? "px-4 py-4" : "px-4 py-4"}`}
              >
                {meetingMessages.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div
                      data-testid={m.role === "user" ? "ai-message-user" : "ai-message-assistant"}
                      className={
                        m.role === "user"
                          ? "max-w-[86%] rounded-xl bg-zk-primary px-3 py-[9px] text-[13px] leading-[1.55] text-white"
                          : "max-w-[86%] rounded-xl bg-zk-surface px-3 py-[9px] text-[13px] leading-[1.55] text-zk-text"
                      }
                    >
                      {m.role === "assistant" ? <SimpleMarkdown text={m.content} /> : <span className="whitespace-pre-wrap">{m.content}</span>}
                    </div>
                  </div>
                ))}
                {meetingSending && (
                  <div className="flex justify-start">
                    <div data-testid="ai-thinking" className="max-w-[86%] rounded-xl bg-zk-surface px-3 py-[9px] text-[13px] text-zk-muted">
                      {meetingStreamingText ? <span className="whitespace-pre-wrap">{meetingStreamingText}</span> : "思考緊…"}
                    </div>
                  </div>
                )}
                {meetingError && (
                  <div data-testid="ai-error" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {meetingError}
                  </div>
                )}
              </div>
            )
          ) : (
          <div
            ref={messageListRef}
            data-testid="ai-message-list"
            className={`flex-1 space-y-3 overflow-y-auto ${isMobile ? "px-4 py-4" : "px-4 py-4"}`}
          >
            {showWelcome && (
              <div className="space-y-3" data-testid="ai-welcome">
                <p className="text-[13px] text-zk-text-secondary">你好，{userName}，今日想問啲咩？</p>
                <div className="flex flex-col gap-2">
                  {EXAMPLE_QUESTIONS.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      data-testid="ai-example-button"
                      onClick={() => handleSubmit(ex)}
                      className="rounded-xl border border-zk-border px-2.5 py-1 text-left text-[11.5px] text-zk-text-secondary hover:bg-zk-header"
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
                      ? `max-w-[86%] bg-zk-primary text-white ${isMobile ? "rounded-[14px] px-[13px] py-2.5 text-sm leading-relaxed" : "rounded-xl px-3 py-[9px] text-[13px] leading-[1.55]"}`
                      : `max-w-[86%] bg-zk-surface text-zk-text ${isMobile ? "rounded-[14px] px-[13px] py-2.5 text-sm leading-relaxed" : "rounded-xl px-3 py-[9px] text-[13px] leading-[1.55]"}`
                  }
                >
                  {m.role === "assistant" ? <SimpleMarkdown text={m.content} /> : <span className="whitespace-pre-wrap">{m.content}</span>}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div data-testid="ai-thinking" className="max-w-[86%] rounded-xl bg-zk-surface px-3 py-[9px] text-[13px] text-zk-muted">
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
          )}

          {meetingMode ? (
            !preview && (
              <div className="border-t border-zk-border">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleMeetingSubmit(meetingInput);
                  }}
                  className="flex items-end gap-2 p-3"
                >
                  <textarea
                    data-testid="ai-input"
                    value={meetingInput}
                    onChange={(e) => setMeetingInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleMeetingSubmit(meetingInput);
                      }
                    }}
                    rows={isMobile ? 1 : 2}
                    placeholder="講清楚你想反映咩……"
                    aria-label="輸入反映內容"
                    disabled={meetingSending}
                    className={
                      isMobile
                        ? "min-h-[44px] flex-1 resize-none rounded-[22px] border border-zk-input-border px-3.5 py-2.5 text-sm focus:border-zk-primary focus:outline-none disabled:bg-zk-header"
                        : "min-h-[40px] flex-1 resize-none rounded-[10px] border border-zk-input-border px-3 py-2 text-[13px] focus:border-zk-primary focus:outline-none disabled:bg-zk-header"
                    }
                  />
                  <button
                    type="submit"
                    data-testid="ai-submit"
                    disabled={meetingSending || !meetingInput.trim()}
                    aria-label="送出"
                    className={
                      isMobile
                        ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zk-primary text-lg font-bold text-white disabled:opacity-50"
                        : "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-zk-primary text-base font-bold text-white disabled:opacity-50"
                    }
                  >
                    ↑
                  </button>
                </form>
                <div className="flex gap-2 border-t border-zk-border px-3 py-2.5">
                  <button
                    type="button"
                    data-testid="ai-feedback-summarize"
                    onClick={handleSummarize}
                    disabled={meetingTurnCount < 2 || summarizing || meetingSending}
                    className="flex-1 rounded-md bg-[#0f172a] px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                  >
                    {summarizing ? "整理緊…" : "整理並送出"}
                  </button>
                  <button
                    type="button"
                    data-testid="ai-feedback-cancel"
                    onClick={handleCancelMeeting}
                    className="rounded-md border border-zk-border px-3 py-2 text-[13px] text-zk-text-secondary hover:bg-zk-surface"
                  >
                    取消開會
                  </button>
                </div>
              </div>
            )
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit(inputValue);
              }}
              className="flex items-end gap-2 border-t border-zk-border p-3"
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
                rows={isMobile ? 1 : 2}
                placeholder={isMobile ? "問啲咩？" : "問啲咩？（Enter 送出，Shift+Enter 換行）"}
                aria-label="輸入問題"
                disabled={sending}
                className={
                  isMobile
                    ? "min-h-[44px] flex-1 resize-none rounded-[22px] border border-zk-input-border px-3.5 py-2.5 text-sm focus:border-zk-primary focus:outline-none disabled:bg-zk-header"
                    : "min-h-[40px] flex-1 resize-none rounded-[10px] border border-zk-input-border px-3 py-2 text-[13px] focus:border-zk-primary focus:outline-none disabled:bg-zk-header"
                }
              />
              <button
                type="submit"
                data-testid="ai-submit"
                disabled={sending || !inputValue.trim()}
                aria-label="送出"
                className={
                  isMobile
                    ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zk-primary text-lg font-bold text-white disabled:opacity-50"
                    : "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-zk-primary text-base font-bold text-white disabled:opacity-50"
                }
              >
                ↑
              </button>
            </form>
          )}

          {meetingToast && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <div className="rounded-full bg-[#0f172a] px-4 py-2 text-xs text-white shadow-lg">{meetingToast}</div>
            </div>
          )}
        </div>
      )}
    </>
  );

  if (!mounted) return null;
  return createPortal(content, document.body);
}
