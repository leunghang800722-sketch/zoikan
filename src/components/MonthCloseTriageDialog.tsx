"use client";
// WP-ONE-CLICK-AUTO §31.3 E＋WP-MC-UI：一鍵結算「要你睇」分診 dialog。
// 桌面：每條題一句原因＋預填建議答案→「一撳確認」；手機（<768px）改 1e 一次一題全屏模式。
// 兩種版面共用同一套 preview／answer API，並且共用「延遲送出」：撳確認／跳過後 5 秒內可撤銷，
// 5 秒到／撳下一題／關閉／切 tab／unmount 先真正 call API（同原本 body 一樣）；失敗標返「未送出，請再試」。
// 冇 PII：盤名、雞頭代號、更種代號、數目。
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { MQ_BELOW_LG } from "@/lib/ui/breakpoints";
import { apiRequest, type ApiResult } from "@/lib/ui/api-client";
import { useTriagePager } from "@/lib/ui/use-triage-pager";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";
import { DeferredSender, type DeferredView } from "@/components/month-close/deferred";
import { UndoToast } from "@/components/month-close/UndoToast";
import { UNDO_NOTE_SHORT, humanize, kindChip, shortHuman } from "@/components/month-close/derive";
import { clearUnsent, pruneUnsent, recordUnsent } from "@/components/month-close/unsent";
import { GuardMatchInfo } from "@/components/reconcile/GuardMatchInfo";

// 送出一律 keepalive：離開頁面時盡力完成（URL／method／body 同原本一樣）。
function apiPost<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), keepalive: true });
}

interface Candidate {
  id: string;
  label: string;
  evidence: string | null;
  values_text: string | null;
}
interface McQuestion {
  id: string;
  kind: string;
  kind_label: string;
  title: string;
  status: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  mc: {
    summary: string;
    suggestion: string | null;
    confidence: "propose" | "unknown";
    action_type: string;
    count: number | null;
    candidates: Candidate[];
    prefill_candidate_id: string | null;
    needs_price_input: boolean;
    needs_broker_pick: boolean;
    broker_options: Array<{ id: string; code: string }>;
    identity_label: string | null;
  };
}
interface Impact {
  can_confirm: boolean;
  summary: string[];
  notes: string[];
}


function useIsMobile(): boolean {
  const [m, setM] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(MQ_BELOW_LG).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MQ_BELOW_LG);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function MonthCloseTriageDialog({ sessionId, onClose, onChanged, month = null }: { sessionId: string; onClose: () => void; onChanged?: () => void; month?: string | null }) {
  const mobile = useIsMobile();
  // P13.1：分頁載入（頭 5 題即刻顯示，快到尾背景 prefetch）；每次送出後重載第一頁（server 可能順手作廢咗其他題）
  const [pagerStatus, setPagerStatus] = useState("open"); // P13.3 由頭開始＝連跳過咗嘅一齊攞
  const pager = useTriagePager<McQuestion>(sessionId, { status: pagerStatus });
  const qs = pager.items;
  const [total0, setTotal0] = useState<number | null>(null);
  // P13.2：回看（viewId＝正在睇邊一題）；P13.3：記住位置；重新答跳過咗嘅題（reopened）
  const [viewId, setViewId] = useState<string | null>(null);
  const labels = useRef<Record<string, string>>({});
  const [reopened, setReopened] = useState<McQuestion[]>([]);
  const [resume, setResume] = useState<{ n: number } | null>(null);
  const baseOffset = useRef<number | null>(null);
  const resumeChecked = useRef(false);
  const posKey = `zk-triage-pos-${sessionId}`;
  const seen = useRef<McQuestion[]>([]); // 本次對話框見過嘅題（按載入次序，唔因重載而消失）
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, { title: string; msg: string }>>({});
  const [done, setDone] = useState<string[]>([]);
  const [okN, setOkN] = useState(0);
  const [skipN, setSkipN] = useState(0);
  const [results, setResults] = useState<Record<string, "ok" | "skip">>({});
  const [view, setView] = useState<DeferredView>({ pending: null, deadline: null, sending: false, inFlight: [] });
  const [candidate, setCandidate] = useState<string>("");
  const [broker, setBroker] = useState<string>("");
  const [price, setPrice] = useState<{ client: string; wage: string; fee: string }>({ client: "", wage: "", fee: "" });
  const drafts = useRef<Record<string, { candidate: string; broker: string; price: { client: string; wage: string; fee: string } }>>({});
  const [expanded, setExpanded] = useState(false);
  const [tapLock, setTapLock] = useState(false);

  const { reload, loadMore, counts } = pager;
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (counts && total0 === null) setTotal0(counts.open + (pagerStatus === "open" ? 0 : counts.skipped));
    if (counts && baseOffset.current === null) baseOffset.current = pagerStatus === "open" ? counts.answered + counts.skipped : 0;
  }, [counts, total0, pagerStatus]);
  useEffect(() => {
    if (!qs) return;
    for (const x of qs) if (!seen.current.some((y) => y.id === x.id)) seen.current.push(x);
    // 全部頁都到齊先知邊啲仲 open（唔准因為淨係第一頁就清走其他題嘅未送出記錄）
    if (!pager.hasMore) pruneUnsent(qs.map((x) => x.id));
  }, [qs, pager.hasMore]);

  // 延遲送出：callbacks 經 ref 讀最新值，sender 只建一次。
  const cbRef = useRef({ onChanged, reload });
  cbRef.current = { onChanged, reload };
  const senderRef = useRef<DeferredSender | null>(null);
  if (senderRef.current === null) {
    senderRef.current = new DeferredSender({
      onChange: (v) => setView(v),
      send: async (item) => {
        if (item.kind === "skip") {
          const r = await apiPost(`/api/triage/questions/${item.id}/answer`, { answer: item.answer });
          return r.ok ? { ok: true } : { ok: false, message: r.message };
        }
        const pv = await apiPost<{ preview_hash: string; writes: boolean; impact: Impact }>(`/api/triage/questions/${item.id}/preview`, { answer: item.answer });
        if (!pv.ok) return { ok: false, message: pv.message };
        const res = await apiPost<{ status: string; impact: Impact | null; note?: string | null }>(`/api/triage/questions/${item.id}/answer`, { answer: item.answer, preview_hash: pv.data.preview_hash });
        if (!res.ok) return { ok: false, message: res.message };
        return { ok: true, detail: `${pv.data.impact.summary.join("；")}${res.data.note ? `——${res.data.note}` : ""}` };
      },
      onSent: (item, detail) => {
        setFailed((f) => {
          const n = { ...f };
          delete n[item.id];
          return n;
        });
        delete drafts.current[item.id];
        clearUnsent(item.id);
        setResults((r) => ({ ...r, [item.id]: item.kind === "skip" ? "skip" : "ok" }));
        if (item.kind === "skip") setSkipN((n) => n + 1);
        else {
          setOkN((n) => n + 1);
          setDone((d) => [...d, `${item.doneLabel}：${humanize(detail ?? "")}`]);
        }
        // 跳過唔改報告數字，唔使再 reload 報告（淨係 reload 分診 session）。
        if (item.kind !== "skip") cbRef.current.onChanged?.();
        void cbRef.current.reload();
      },
      onFailed: (item, message) => {
        setFailed((f) => ({ ...f, [item.id]: { title: item.title, msg: message } }));
        recordUnsent({ id: item.id, title: item.title, option: String(item.answer.option ?? "") });
      },
    });
  }
  const sender = senderRef.current;

  // 離開頁面／切 tab／unmount 前 flush（唔准靜靜丟失）。
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void sender.flush();
    };
    const onBefore = (e: BeforeUnloadEvent) => {
      if (sender.hasPending()) {
        void sender.flush();
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onBefore);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onBefore);
      void sender.flush();
    };
  }, [sender]);

  const pendingId = view.pending?.id ?? null;
  const visible = [...reopened, ...(qs ?? []).filter((x) => !reopened.some((y) => y.id === x.id))].filter((x) => !view.inFlight.includes(x.id) && !results[x.id]);
  const q = visible[0] ?? null;
  useEffect(() => {
    if (pager.hasMore && !pager.loadingMore && visible.length <= 3) void loadMore(); // 去到每頁第 3 題就背景攞下一頁
  }, [pager.hasMore, pager.loadingMore, visible.length, loadMore]);
  useEffect(() => {
    const d = q ? drafts.current[q.id] : undefined;
    setCandidate(d?.candidate ?? "");
    setBroker(d?.broker ?? "");
    setPrice(d?.price ?? { client: "", wage: "", fee: "" });
    setExpanded(!!d);
    setTapLock(true); // 1e：新題出現後 400ms 內唔俾撳，避免雙撳撞中下一題
    const t = setTimeout(() => setTapLock(false), 400);
    return () => clearTimeout(t);
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { close: closeDialog } = useHistoryOverlay(true, () => void finishClose(), `mc-triage-${sessionId}`); // P13.5：返回＝關對話框
  const liveId = q?.id ?? null;
  useEffect(() => {
    if (!liveId || baseOffset.current === null) return;
    const n = baseOffset.current + okN + skipN + 1;
    if (!resumeChecked.current) {
      resumeChecked.current = true;
      try {
        const raw = window.sessionStorage.getItem(posKey);
        const st = raw ? (JSON.parse(raw) as { id?: string; n?: number }) : null;
        if (st && st.id === liveId && typeof st.n === "number" && st.n > 1) setResume({ n: st.n });
      } catch {
        /* ignore */
      }
    }
    try {
      window.sessionStorage.setItem(posKey, JSON.stringify({ id: liveId, n }));
    } catch {
      /* ignore */
    }
  }, [liveId, okN, skipN, posKey, counts]);

  async function finishClose() {
    await sender.flush();
    // 送出失敗（含 5 秒 timer 自動送出失敗）：一律唔關對話框（✕／遲啲先答／撳遮罩都一樣），
    // 失敗 banner 有明確掣「放棄未送出嘅 N 題」先放棄（失敗題已記 sessionStorage，頁面會提示重新答）。
    if (sender.failedCount() > 0) return;
    onClose();
  }
  // 收起「揀其他答案」＝放棄所揀嘅其他答案（候選／雞頭／價錢），主掣變返「確認建議」；想保留就唔好收起。
  function toggleOther() {
    if (expanded) {
      setCandidate("");
      setBroker("");
      setPrice({ client: "", wage: "", fee: "" });
    }
    setExpanded(!expanded);
  }
  async function abandonUnsent() {
    await sender.flush();
    onClose();
  }
  function restartFromBeginning() {
    try {
      window.sessionStorage.removeItem(posKey);
    } catch {
      /* ignore */
    }
    setResume(null);
    setViewId(null);
    setReopened([]);
    setResults({});
    setOkN(0);
    setSkipN(0);
    setDone([]);
    seen.current = [];
    baseOffset.current = 0;
    setTotal0(null);
    setPagerStatus("open,skipped");
  }
  function reanswer(id: string) {
    const item = seen.current.find((x) => x.id === id);
    if (!item) return;
    setReopened((l) => (l.some((x) => x.id === id) ? l : [...l, item]));
    setResults((r) => {
      const n = { ...r };
      delete n[id];
      return n;
    });
    setSkipN((n) => Math.max(0, n - 1));
    setViewId(null);
  }

  function schedule(kind: "confirm" | "skip", answer: Record<string, unknown>, doneLabel: string) {
    if (!q) return;
    setError(null);
    setFailed((f) => {
      const n = { ...f };
      delete n[q.id];
      return n;
    });
    clearUnsent(q.id); // 重試中；再失敗會重新記低
    drafts.current[q.id] = { candidate, broker, price };
    labels.current[q.id] = kind === "skip" ? "跳過，留返人手" : doneLabel;
    setResume(null);
    void sender.schedule({ id: q.id, kind, answer, doneLabel, title: q.title });
  }
  const skip = () => schedule("skip", { option: "skip" }, "跳過");
  const has = (id: string) => q?.options.some((o) => o.id === id) ?? false;
  const priceBody = () => ({
    option: "mc_price",
    price: {
      ...(price.client ? { client_rate: Number(price.client) } : {}),
      ...(price.wage ? { guard_wage: Number(price.wage) } : {}),
      ...(price.fee ? { broker_fee: Number(price.fee) } : {}),
    },
  });
  const undo = () => {
    sender.undo();
    setError(null);
  };

  const failedMsg = q ? failed[q.id]?.msg : undefined;
  const failedIds = Object.keys(failed);
  const handled = okN + skipN;
  const loadingQs = qs === null || (!q && (pager.hasMore || pager.loadingMore));
  const allClear = !loadingQs && !q;
  const waiting = allClear && (view.pending !== null || view.sending);

  // 共用答案表單（候選／雞頭／自己輸入價錢）
  const form = q ? (
    <>
      {q.mc.candidates.length > 0 && (
        <fieldset className="space-y-1.5" disabled={false}>
          <legend className="text-zk-sm font-semibold">候選</legend>
          {q.mc.candidates.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-zk-border p-2 text-zk-base has-[:checked]:border-zk-primary has-[:checked]:bg-zk-primary-tint-soft">
              <input
                type="radio"
                name="mc-candidate"
                className="mt-0.5"
                checked={(candidate || q.mc.prefill_candidate_id || "") === c.id}
                onChange={() => {
                  setCandidate(c.id);
                }}
              />
              <span className="flex-1">
                {humanize(c.label)}
                {c.values_text ? <b className="ml-1">{c.values_text}</b> : null}
                {c.evidence ? <span className="block text-zk-xs text-zk-faint">{humanize(c.evidence)}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {q.mc.needs_broker_pick && has("mc_pick") && (
        <label className="block text-zk-sm">
          <span className="mb-1 block text-zk-muted">或者揀其他結算雞頭</span>
          <select
            className="w-full rounded-[5px] border border-zk-border px-2 py-1.5"
            aria-label="結算雞頭"
            value={broker}
            onChange={(e) => {
              setBroker(e.target.value);
            }}
          >
            <option value="">揀雞頭…</option>
            {q.mc.broker_options.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </select>
        </label>
      )}
      {q.mc.needs_price_input && has("mc_price") && (
        <fieldset className="space-y-1.5 rounded border border-zk-border p-2">
          <legend className="px-1 text-zk-sm font-semibold">自己輸入價錢（元／更）</legend>
          <div className="grid grid-cols-3 gap-2">
            {([["client", "客價"], ["wage", "工資"], ["fee", "雞頭費"]] as const).map(([k, label]) => (
              <label key={k} className="block text-zk-sm">
                <span className="text-zk-muted">{label}</span>
                <input
                  inputMode="decimal"
                  className="mt-0.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5"
                  aria-label={label}
                  value={price[k]}
                  onChange={(e) => {
                    setPrice((p) => ({ ...p, [k]: e.target.value.replace(/[^0-9.]/g, "") }));
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  ) : null;

  // 各答案動作（桌面／手機共用）
  const canPick = !!q && !q.mc.needs_broker_pick && has("mc_pick") && !!candidate && candidate !== q.mc.prefill_candidate_id;
  const actions = {
    accept: () => schedule("confirm", { option: "mc_accept" }, "一撳確認"),
    ack: () => schedule("confirm", { option: "mc_ack" }, "已覆核"),
    isNew: () => schedule("confirm", { option: "mc_new" }, "當新盤"),
    price: () => schedule("confirm", priceBody(), "輸入價錢"),
    pickBroker: () => schedule("confirm", { option: "mc_pick", value: broker }, "揀結算雞頭"),
    pick: () => schedule("confirm", { option: "mc_pick", candidate_id: candidate }, "揀候選"),
  };
  const priceReady = !!(price.client || price.wage || price.fee);
  // 用戶揀咗建議以外嘅答案（其他候選／雞頭／自己輸入價錢）→ 主掣改寫入所揀答案，唔再寫建議答案。
  const choseOther = !!q && ((!!candidate && candidate !== q.mc.prefill_candidate_id) || !!broker || (q.mc.needs_price_input && priceReady));

  const toast = view.pending && view.deadline ? <UndoToast item={view.pending} deadline={view.deadline} onUndo={undo} /> : null;
  const failedBanner =
    failedIds.length > 0 ? (
      <div className="flex flex-col gap-2 rounded border border-zk-danger-border bg-zk-danger-bg px-3 py-2 text-zk-sm text-zk-danger-dark" data-testid="mc-failed-banner" role="alert">
        <div>有 {failedIds.length} 題未送出，請再試：{failedIds.map((id) => shortHuman(failed[id]!.title)).join("、")}</div>
        <Button variant="danger" size="sm" className="self-start" type="button" onClick={abandonUnsent} data-testid="mc-abandon">
          放棄未送出嘅 {failedIds.length} 題（留返待答問題）
        </Button>
      </div>
    ) : null;
  const retryTag = failedMsg ? <div className="rounded border border-zk-danger-border bg-zk-danger-bg px-3 py-2 text-zk-sm text-zk-danger-dark" data-testid="mc-unsent">未送出，請再試（{humanize(failedMsg)}）</div> : null;

  // P13.2 回看已處理嘅題（唔可以改；跳過嘅可以重新答）
  const handledQs = seen.current.filter((x) => results[x.id] || view.inFlight.includes(x.id));
  const viewQ = viewId ? (seen.current.find((x) => x.id === viewId) ?? null) : null;
  const viewIdx = viewQ ? handledQs.findIndex((x) => x.id === viewQ.id) : -1;
  const prevTarget = viewQ ? (viewIdx > 0 ? handledQs[viewIdx - 1] : null) : (handledQs[handledQs.length - 1] ?? null);
  const nextTarget = viewQ ? (viewIdx >= 0 && viewIdx + 1 < handledQs.length ? handledQs[viewIdx + 1]! : null) : null;
  const viewState = viewQ ? (results[viewQ.id] === "skip" ? "skip" : view.inFlight.includes(viewQ.id) ? "sending" : "ok") : null;
  const navRow =
    handledQs.length > 0 || viewQ ? (
      <div className="flex items-center justify-between gap-2" data-testid="mc-nav">
        <Button variant="secondary" size="sm" type="button" disabled={!prevTarget} onClick={() => prevTarget && setViewId(prevTarget.id)} data-testid="mc-prev">
          ‹ 上一題
        </Button>
        {viewQ && (
          <Button variant="secondary" size="sm" type="button" onClick={() => setViewId(nextTarget ? nextTarget.id : null)} data-testid="mc-next">
            下一題 ›
          </Button>
        )}
      </div>
    ) : null;
  const viewPanel = viewQ ? (
    <div className="flex flex-col gap-3" data-testid="mc-readonly">
      <div className="flex flex-wrap items-center gap-2">
        <Pill variant="neutral">{kindChip(viewQ.kind, viewQ.kind_label)}</Pill>
        <Pill variant={viewState === "skip" ? "warning" : "success"}>{viewState === "skip" ? "已跳過" : viewState === "sending" ? "送出中（可撤銷）" : "已送出"}</Pill>
      </div>
      <div className="text-zk-md font-medium">{humanize(viewQ.title)}</div>
      <div className="text-zk-sm text-zk-muted">{humanize(viewQ.mc.summary)}</div>
      <div className="rounded-lg border border-zk-border bg-zk-surface-2 p-3 text-zk-base">
        你選咗：<b>{humanize(labels.current[viewQ.id] ?? "")}</b>
        {viewState !== "skip" && <div className="mt-1 text-zk-xs text-zk-muted">已經處理，唔可以喺度改。</div>}
      </div>
      {viewState === "skip" && (
        <Button variant="primary" onClick={() => reanswer(viewQ.id)} data-testid="mc-reanswer">
          重新答呢題
        </Button>
      )}
    </div>
  ) : null;
  const resumeBanner =
    resume && !viewQ && q ? (
      <div className="text-zk-xs text-zk-faint" data-testid="mc-resume">
        由第 {resume.n} 題繼續 ·{" "}
        <button type="button" className="underline" onClick={restartFromBeginning} data-testid="mc-restart">
          由頭開始
        </button>
      </div>
    ) : null;

  // ------------------------------------------------------------------ 手機 1e
  if (mobile) {
    const total = total0 ?? 0;
    // 超過 60 題唔畫分段條（淨係文字 N / M）；未載入嘅題用預設色
    const segIds = total > 60 ? [] : Array.from({ length: total }, (_, i) => seen.current[i]?.id ?? `pending-${i}`);
    const segs = segIds.map((id) => {
      const x = { id };
      const r = results[x.id];
      const c = r === "ok" ? "var(--zk-success)" : r === "skip" ? "var(--zk-faintest)" : x.id === pendingId ? "var(--zk-primary-light)" : x.id === q?.id ? "var(--zk-primary)" : "var(--zk-border)";
      return { id: x.id, c };
    });
    const pos = Math.min(total, handled + (view.pending ? 1 : 0) + (q ? 1 : 0));
    const suggestCand = q?.mc.candidates.find((c) => c.id === q.mc.prefill_candidate_id) ?? null;
    const canAccept = !!q && has("mc_accept") && !!q.mc.prefill_candidate_id;
    const ackOnly = !!q && !canAccept && has("mc_ack") && !q.mc.needs_price_input && !q.mc.needs_broker_pick && q.mc.candidates.length === 0;
    // 主掣
    let primary: { label: string; run: () => void; dark?: boolean; disabled?: boolean; testid: string } | null = null;
    if (q) {
      if (expanded && choseOther && q.mc.needs_price_input && has("mc_price") && priceReady) primary = { label: "用我輸入嘅價錢", run: actions.price, dark: true, testid: "mc-price" };
      else if (expanded && choseOther && q.mc.needs_broker_pick && broker) primary = { label: "歸所揀雞頭", run: actions.pickBroker, dark: true, testid: "mc-pick-broker" };
      else if (expanded && choseOther && canPick) primary = { label: "用所揀答案", run: actions.pick, dark: true, testid: "mc-pick" };
      else if (canAccept) primary = { label: "確認建議", run: actions.accept, testid: "mc-accept" };
      else if (ackOnly) primary = { label: "我已覆核，冇問題", run: actions.ack, testid: "mc-ack" };
      else if (!expanded) primary = { label: "揀答案 ›", run: () => setExpanded(true), dark: true, testid: "mc-choose" };
      else if (q.mc.needs_price_input && has("mc_price") && priceReady) primary = { label: "用我輸入嘅價錢", run: actions.price, dark: true, testid: "mc-price" };
      else if (q.mc.needs_broker_pick && broker) primary = { label: "歸所揀雞頭", run: actions.pickBroker, dark: true, testid: "mc-pick-broker" };
      else if (canPick) primary = { label: "用所揀候選", run: actions.pick, dark: true, testid: "mc-pick" };
      else primary = { label: "揀答案 ›", run: () => {}, dark: true, disabled: true, testid: "mc-choose" };
    }
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" data-testid="mc-triage-dialog" data-mode="mobile">
        <div className="flex flex-col gap-2.5 border-b border-zk-border-soft px-4 py-3">
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={closeDialog} className="text-zk-base font-semibold text-zk-primary" aria-label="返回列表" data-testid="mc-later">
              ‹ 返回列表
            </button>
            <span className="flex-1 text-zk-md font-bold">要你睇</span>
            {total > 0 && !allClear && <span className="text-zk-base text-zk-muted" data-testid="mc-pos">{pos} / {total}</span>}
          </div>
          {resumeBanner}
          <div className="flex gap-0.5" data-testid="mc-segs">
            {segs.map((s) => (
              <span key={s.id} className="h-1 flex-1 rounded-sm" style={{ background: s.c }} />
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-40 pt-5">
          {failedBanner}
          {error && !failedMsg && <Banner kind="error" className="mb-3">{error}</Banner>}
          {loadingQs && <div className="text-zk-base text-zk-muted" data-testid="mc-loading">載入緊…</div>}
          {viewPanel}
          {q && !viewQ && (
            <div className="flex flex-col gap-4">
              {retryTag}
              <div className="flex gap-1.5">
                <span className="rounded-[10px] bg-zk-surface px-2 py-[3px] text-zk-xs font-semibold text-zk-text-secondary">{kindChip(q.kind, q.kind_label)}</span>
                <span className="rounded-[10px] px-2 py-[3px] text-zk-xs font-semibold" style={q.mc.confidence === "propose" ? { background: "var(--zk-primary-tint)", color: "var(--zk-primary-deep)" } : { background: "var(--zk-warning-tint)", color: "var(--zk-warning)" }}>
                  {q.mc.confidence === "propose" ? "有建議" : "要你揀"}
                </span>
              </div>
              <div>
                <div className="text-zk-xl font-bold leading-[1.35]">{humanize(q.title)}</div>
                <div className="mt-1 text-zk-md text-zk-text-secondary" data-testid="mc-summary">
                  {humanize(q.mc.summary)}
                </div>
                {q.mc.identity_label && <div className="mt-1 text-zk-sm text-zk-faint">更表身份：{humanize(q.mc.identity_label)}</div>}
              </div>
              <GuardMatchInfo question={q} month={month} compact />
              {canAccept ? (
                <div className={`rounded-[14px] border-2 px-4 py-3.5 ${choseOther ? "border-zk-faintest bg-white opacity-60" : "border-zk-primary bg-zk-primary-tint-soft"}`} data-testid="mc-suggest-card">
                  <div className="text-zk-sm font-semibold text-zk-primary-dark">系統建議</div>
                  <div className="mt-1 text-zk-xl font-bold">{humanize(q.mc.suggestion ?? (suggestCand ? `${suggestCand.label}${suggestCand.values_text ? ` ${suggestCand.values_text}` : ""}` : "按建議答案"))}</div>
                  {suggestCand?.evidence && <div className="mt-1.5 text-zk-sm text-zk-muted">依據：{humanize(suggestCand.evidence)}</div>}
                </div>
              ) : (
                <div className="rounded-[14px] border border-dashed border-zk-faintest bg-zk-surface-2 px-4 py-3.5" data-testid="mc-nosuggest-card">
                  <div className="text-zk-sm font-semibold text-zk-muted">冇建議答案</div>
                  <div className="mt-1 text-zk-base leading-normal text-zk-text-secondary">系統唔肯自己決定，要你揀。</div>
                </div>
              )}
              {(canAccept || !ackOnly) && (
                <button type="button" className="text-center text-zk-base text-zk-primary" onClick={toggleOther} data-testid="mc-other">
                  揀其他答案／自己輸入
                </button>
              )}
              {expanded && (
                <div className="space-y-3">
                  {form}
                  <div className="flex flex-wrap gap-2">
                    {has("mc_new") && (
                      <Button onClick={actions.isNew} data-testid="mc-new">
                        唔係，當新盤
                      </Button>
                    )}
                    {has("mc_ack") && !ackOnly && (
                      <Button onClick={actions.ack} data-testid="mc-ack">
                        我已覆核，冇問題
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {allClear && !viewQ && (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2.5 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-zk-success-tint text-2xl font-bold text-zk-success">✓</span>
              <div className="text-zk-xl font-bold" data-testid="mc-finish">{waiting ? "等緊最後一題送出" : `${handled} 題處理完`}</div>
              <div className="text-zk-base text-zk-muted">
                {waiting ? "5 秒內仲可以撤銷。" : <>確認 {okN} · 跳過 {skipN}<br />跳過嘅留咗喺「待答問題」，有時間再答。</>}
              </div>
              {!waiting && okN > 0 && <div className="max-w-[300px] text-zk-xs leading-snug text-zk-faint">想還原系統自動做嘅改動？{UNDO_NOTE_SHORT}</div>}
              {!waiting && (
                <button type="button" onClick={closeDialog} className="mt-2 h-[46px] rounded-[10px] border border-zk-faintest bg-white px-6 text-sm" data-testid="mc-back">
                  返回
                </button>
              )}
            </div>
          )}
          {navRow && <div className="mt-4 border-t border-zk-border-soft pt-3">{navRow}</div>}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 border-t border-zk-border bg-white px-4 pb-5 pt-3">
          {toast}
          {q && !viewQ && primary && (
            <div className="flex gap-2.5">
              <button type="button" onClick={skip} disabled={tapLock} className="h-[54px] flex-1 disabled:opacity-40 rounded-xl border border-zk-faintest bg-white text-zk-md font-semibold text-zk-text-secondary" data-testid="mc-skip">
                跳過，留返人手
              </button>
              <button type="button" onClick={primary.run} disabled={primary.disabled || tapLock} data-testid={primary.testid} className="h-[54px] flex-1 rounded-xl text-zk-md font-semibold text-white disabled:opacity-40" style={{ background: primary.dark ? "var(--zk-text)" : "var(--zk-primary)" }}>
                {primary.label}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ 桌面
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" data-testid="mc-triage-dialog" data-mode="desktop">
      <div className="absolute inset-0 bg-black/40" onClick={closeDialog} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-zk-border px-4 py-3">
          <Button variant="secondary" size="sm" type="button" onClick={closeDialog} data-testid="mc-later" aria-label="返回列表">
            ‹ 返回列表
          </Button>
          <div className="min-w-0 flex-1">
            <div className="text-zk-md font-semibold">一鍵結算——要你睇</div>
            {qs && <div className="text-zk-sm text-zk-muted">仲有 {pager.hasMore ? Math.max(visible.length, (total0 ?? 0) - okN - skipN - view.inFlight.length) : visible.length} 題（每題一句原因，預填建議答案，一撳確認）{view.inFlight.length > 0 ? ` · ${view.inFlight.length} 題送出中${view.pending ? "（可撤銷）" : ""}` : ""}</div>}
            {resumeBanner}
          </div>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {failedBanner}
          {error && !failedMsg && <Banner kind="error">{error}</Banner>}
          {done.length > 0 && (
            <ul className="list-disc space-y-0.5 rounded border border-zk-success/30 bg-zk-success-bg px-5 py-2 text-zk-sm text-zk-success-dark" data-testid="mc-done">
              {done.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {loadingQs && <div className="text-zk-base text-zk-muted" data-testid="mc-loading">載入緊…</div>}
          {allClear && !viewQ && (
            <div className="space-y-2 py-6 text-center">
              <div className="text-zk-md font-semibold" data-testid="mc-finish">{waiting ? "等緊最後一題送出（5 秒內可撤銷）" : `${handled} 題處理完`}</div>
              {!waiting && <div className="text-zk-sm text-zk-muted">確認 {okN} · 跳過 {skipN}　跳過嘅留咗喺「待答問題」。</div>}
              {!waiting && (
                <Button variant="primary" onClick={closeDialog}>
                  完成
                </Button>
              )}
            </div>
          )}
          {viewPanel}
          {q && !viewQ && (
            <>
              {retryTag}
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="neutral">{kindChip(q.kind, q.kind_label)}</Pill>
                <Pill variant={q.mc.confidence === "propose" ? "warning" : "danger"}>{q.mc.confidence === "propose" ? "有建議" : "要你揀"}</Pill>
              </div>
              <div className="text-zk-md font-medium">{humanize(q.title)}</div>
              <div className="text-zk-sm text-zk-muted" data-testid="mc-summary">
                {humanize(q.mc.summary)}
              </div>
              {q.mc.identity_label && <div className="text-zk-sm text-zk-faint">更表身份：{humanize(q.mc.identity_label)}</div>}
              <GuardMatchInfo question={q} month={month} />
              {form}
            </>
          )}
          {navRow}
        </div>
        {((q && !viewQ) || toast) && (
          <div className="flex flex-col gap-2 border-t border-zk-border px-4 py-3">
            {toast}
            {q && !viewQ && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button onClick={skip} data-testid="mc-skip">
                  跳過，留返人手
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  {has("mc_new") && (
                    <Button onClick={actions.isNew} data-testid="mc-new">
                      唔係，當新盤
                    </Button>
                  )}
                  {has("mc_ack") && (
                    <Button variant="primary" onClick={actions.ack} data-testid="mc-ack">
                      我已覆核，冇問題
                    </Button>
                  )}
                  {q.mc.needs_price_input && has("mc_price") && (
                    <Button disabled={!priceReady} onClick={actions.price} data-testid="mc-price">
                      用我輸入嘅價錢
                    </Button>
                  )}
                  {q.mc.needs_broker_pick && broker && (
                    <Button onClick={actions.pickBroker} data-testid="mc-pick-broker">
                      歸所揀雞頭
                    </Button>
                  )}
                  {canPick && (
                    <Button onClick={actions.pick} data-testid="mc-pick">
                      用所揀候選
                    </Button>
                  )}
                  {has("mc_accept") && q.mc.prefill_candidate_id && !choseOther && (
                    <Button variant="primary" onClick={actions.accept} data-testid="mc-accept">
                      一撳確認
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
