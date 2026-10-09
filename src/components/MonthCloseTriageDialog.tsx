"use client";
// WP-ONE-CLICK-AUTO §31.3 E＋WP-MC-UI：一鍵結算「要你睇」分診 dialog。
// 桌面：每條題一句原因＋預填建議答案→「一撳確認」；手機（<768px）改 1e 一次一題全屏模式。
// 兩種版面共用同一套 preview／answer API，並且共用「延遲送出」：撳確認／跳過後 5 秒內可撤銷，
// 5 秒到／撳下一題／關閉／切 tab／unmount 先真正 call API（同原本 body 一樣）；失敗標返「未送出，請再試」。
// 冇 PII：盤名、雞頭代號、更種代號、數目。
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiRequest, type ApiResult } from "@/lib/ui/api-client";
import { DeferredSender, type DeferredView } from "@/components/month-close/deferred";
import { UndoToast } from "@/components/month-close/UndoToast";
import { UNDO_NOTE_SHORT, humanize, kindChip, shortHuman } from "@/components/month-close/derive";
import { clearUnsent, pruneUnsent, recordUnsent } from "@/components/month-close/unsent";

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
interface SessionRes {
  session: { id: string; status: string; counts: { open: number; answered: number; skipped: number; total: number } };
  questions: McQuestion[];
}
interface Impact {
  can_confirm: boolean;
  summary: string[];
  notes: string[];
}


function useIsMobile(): boolean {
  const [m, setM] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767px)").matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function MonthCloseTriageDialog({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged?: () => void }) {
  const mobile = useIsMobile();
  const [qs, setQs] = useState<McQuestion[] | null>(null);
  const [initial, setInitial] = useState<McQuestion[] | null>(null);
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

  const load = useCallback(async () => {
    const res = await apiGet<SessionRes>(`/api/triage/sessions/${sessionId}`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const open = res.data.questions.filter((q) => q.status === "open");
    setQs(open);
    pruneUnsent(open.map((x) => x.id));
    setInitial((prev) => prev ?? open);
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load]);

  // 延遲送出：callbacks 經 ref 讀最新值，sender 只建一次。
  const cbRef = useRef({ onChanged, load });
  cbRef.current = { onChanged, load };
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
        void cbRef.current.load();
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
  const visible = (qs ?? []).filter((x) => !view.inFlight.includes(x.id) && !results[x.id]);
  const q = visible[0] ?? null;
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

  async function closeDialog() {
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
  const allClear = qs !== null && !q;
  const waiting = allClear && (view.pending !== null || view.sending);

  // 共用答案表單（候選／雞頭／自己輸入價錢）
  const form = q ? (
    <>
      {q.mc.candidates.length > 0 && (
        <fieldset className="space-y-1.5" disabled={false}>
          <legend className="text-[12.5px] font-semibold">候選</legend>
          {q.mc.candidates.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-zk-border p-2 text-[13px] has-[:checked]:border-zk-primary has-[:checked]:bg-blue-50">
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
                {c.evidence ? <span className="block text-[11.5px] text-zk-faint">{humanize(c.evidence)}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {q.mc.needs_broker_pick && has("mc_pick") && (
        <label className="block text-[12.5px]">
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
          <legend className="px-1 text-[12.5px] font-semibold">自己輸入價錢（元／更）</legend>
          <div className="grid grid-cols-3 gap-2">
            {([["client", "客價"], ["wage", "工資"], ["fee", "雞頭費"]] as const).map(([k, label]) => (
              <label key={k} className="block text-[12px]">
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
      <div className="flex flex-col gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" data-testid="mc-failed-banner" role="alert">
        <div>有 {failedIds.length} 題未送出，請再試：{failedIds.map((id) => shortHuman(failed[id]!.title)).join("、")}</div>
        <button type="button" onClick={abandonUnsent} className="self-start rounded border border-red-300 bg-white px-2.5 py-1 text-red-700" data-testid="mc-abandon">
          放棄未送出嘅 {failedIds.length} 題（留返待答問題）
        </button>
      </div>
    ) : null;
  const retryTag = failedMsg ? <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" data-testid="mc-unsent">未送出，請再試（{humanize(failedMsg)}）</div> : null;

  // ------------------------------------------------------------------ 手機 1e
  if (mobile) {
    const segs = (initial ?? []).map((x) => {
      const r = results[x.id];
      const c = r === "ok" ? "#0f766e" : r === "skip" ? "#cbd5e1" : x.id === pendingId ? "#93c5fd" : x.id === q?.id ? "#2563eb" : "#e2e8f0";
      return { id: x.id, c };
    });
    const total = initial?.length ?? 0;
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
            <button type="button" onClick={closeDialog} className="text-xl leading-none" aria-label="遲啲先答" data-testid="mc-later">
              ✕
            </button>
            <span className="flex-1 text-[15px] font-bold">要你睇</span>
            {total > 0 && !allClear && <span className="text-[13px] text-zk-muted" data-testid="mc-pos">{pos} / {total}</span>}
          </div>
          <div className="flex gap-0.5" data-testid="mc-segs">
            {segs.map((s) => (
              <span key={s.id} className="h-1 flex-1 rounded-sm" style={{ background: s.c }} />
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-40 pt-5">
          {failedBanner}
          {error && !failedMsg && <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
          {qs === null && <div className="text-[13px] text-zk-muted">載入緊…</div>}
          {q && (
            <div className="flex flex-col gap-4">
              {retryTag}
              <div className="flex gap-1.5">
                <span className="rounded-[10px] bg-zk-surface px-2 py-[3px] text-[11.5px] font-semibold text-[#475569]">{kindChip(q.kind, q.kind_label)}</span>
                <span className="rounded-[10px] px-2 py-[3px] text-[11.5px] font-semibold" style={q.mc.confidence === "propose" ? { background: "#dbeafe", color: "#1e40af" } : { background: "#ffedd5", color: "#c2410c" }}>
                  {q.mc.confidence === "propose" ? "有建議" : "要你揀"}
                </span>
              </div>
              <div>
                <div className="text-[21px] font-bold leading-[1.35]">{humanize(q.title)}</div>
                <div className="mt-1 text-[15px] text-[#334155]" data-testid="mc-summary">
                  {humanize(q.mc.summary)}
                </div>
                {q.mc.identity_label && <div className="mt-1 text-[12px] text-zk-faint">更表身份：{humanize(q.mc.identity_label)}</div>}
              </div>
              {canAccept ? (
                <div className={`rounded-[14px] border-2 px-4 py-3.5 ${choseOther ? "border-[#cbd5e1] bg-white opacity-60" : "border-[#2563eb] bg-[#f8fbff]"}`} data-testid="mc-suggest-card">
                  <div className="text-[12px] font-semibold text-[#1d4ed8]">系統建議</div>
                  <div className="mt-1 text-[20px] font-bold">{humanize(q.mc.suggestion ?? (suggestCand ? `${suggestCand.label}${suggestCand.values_text ? ` ${suggestCand.values_text}` : ""}` : "按建議答案"))}</div>
                  {suggestCand?.evidence && <div className="mt-1.5 text-[12px] text-zk-muted">依據：{humanize(suggestCand.evidence)}</div>}
                </div>
              ) : (
                <div className="rounded-[14px] border border-dashed border-[#cbd5e1] bg-zk-surface-2 px-4 py-3.5" data-testid="mc-nosuggest-card">
                  <div className="text-[12px] font-semibold text-zk-muted">冇建議答案</div>
                  <div className="mt-1 text-[13.5px] leading-normal text-[#334155]">系統唔肯自己決定，要你揀。</div>
                </div>
              )}
              {(canAccept || !ackOnly) && (
                <button type="button" className="text-center text-[13.5px] text-zk-primary" onClick={toggleOther} data-testid="mc-other">
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
          {allClear && (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2.5 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#ccfbf1] text-2xl font-bold text-[#0f766e]">✓</span>
              <div className="text-[19px] font-bold" data-testid="mc-finish">{waiting ? "等緊最後一題送出" : `${handled} 題處理完`}</div>
              <div className="text-[13.5px] text-zk-muted">
                {waiting ? "5 秒內仲可以撤銷。" : <>確認 {okN} · 跳過 {skipN}<br />跳過嘅留咗喺「待答問題」，有時間再答。</>}
              </div>
              {!waiting && okN > 0 && <div className="max-w-[300px] text-[11.5px] leading-snug text-zk-faint">想還原系統自動做嘅改動？{UNDO_NOTE_SHORT}</div>}
              {!waiting && (
                <button type="button" onClick={closeDialog} className="mt-2 h-[46px] rounded-[10px] border border-[#cbd5e1] bg-white px-6 text-sm" data-testid="mc-back">
                  返回
                </button>
              )}
            </div>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 border-t border-zk-border bg-white px-4 pb-5 pt-3">
          {toast}
          {q && primary && (
            <div className="flex gap-2.5">
              <button type="button" onClick={skip} disabled={tapLock} className="h-[54px] flex-1 disabled:opacity-40 rounded-xl border border-[#cbd5e1] bg-white text-[15px] font-semibold text-[#334155]" data-testid="mc-skip">
                跳過，留返人手
              </button>
              <button type="button" onClick={primary.run} disabled={primary.disabled || tapLock} data-testid={primary.testid} className="h-[54px] flex-1 rounded-xl text-[15px] font-semibold text-white disabled:opacity-40" style={{ background: primary.dark ? "#0f172a" : "#2563eb" }}>
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
          <div>
            <div className="text-[15px] font-semibold">一鍵結算——要你睇</div>
            {qs && <div className="text-[12px] text-zk-muted">仲有 {visible.length} 題（每題一句原因，預填建議答案，一撳確認）{view.inFlight.length > 0 ? ` · ${view.inFlight.length} 題送出中${view.pending ? "（可撤銷）" : ""}` : ""}</div>}
          </div>
          <button type="button" onClick={closeDialog} className="rounded px-2 py-1 text-[13px] text-zk-muted hover:bg-zk-header" data-testid="mc-later">
            遲啲先答
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {failedBanner}
          {error && !failedMsg && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
          {done.length > 0 && (
            <ul className="list-disc space-y-0.5 rounded border border-green-300 bg-green-50 px-5 py-2 text-[12px] text-green-800" data-testid="mc-done">
              {done.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {qs === null && <div className="text-[13px] text-zk-muted">載入緊…</div>}
          {allClear && (
            <div className="space-y-2 py-6 text-center">
              <div className="text-[15px] font-semibold" data-testid="mc-finish">{waiting ? "等緊最後一題送出（5 秒內可撤銷）" : `${handled} 題處理完`}</div>
              {!waiting && <div className="text-[12.5px] text-zk-muted">確認 {okN} · 跳過 {skipN}　跳過嘅留咗喺「待答問題」。</div>}
              {!waiting && (
                <Button variant="primary" onClick={closeDialog}>
                  完成
                </Button>
              )}
            </div>
          )}
          {q && (
            <>
              {retryTag}
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="neutral">{kindChip(q.kind, q.kind_label)}</Pill>
                <Pill variant={q.mc.confidence === "propose" ? "warning" : "danger"}>{q.mc.confidence === "propose" ? "有建議" : "要你揀"}</Pill>
              </div>
              <div className="text-[14px] font-medium">{humanize(q.title)}</div>
              <div className="text-[12.5px] text-zk-muted" data-testid="mc-summary">
                {humanize(q.mc.summary)}
              </div>
              {q.mc.identity_label && <div className="text-[12px] text-zk-faint">更表身份：{humanize(q.mc.identity_label)}</div>}
              {form}
            </>
          )}
        </div>
        {(q || toast) && (
          <div className="flex flex-col gap-2 border-t border-zk-border px-4 py-3">
            {toast}
            {q && (
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
