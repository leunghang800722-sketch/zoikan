"use client";
// P8.2：「批量接受建議（N 題）」。流程：撳掣 → 對話框列出有系統建議嘅題（可逐題取消剔）→ 確認 →
// 5 秒撤銷條（UndoBar，前端延遲送出；撤銷＝零請求）→ POST /api/triage/questions/batch-accept → 結果摘要。
// 送出之後嘅撤銷同人手單題答一樣：冇（要逐題用「撤銷補齊」等現有還原功能）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { UndoBar } from "@/components/ui/UndoBar";
import { DEFERRED_UNDO_MS } from "@/components/month-close/deferred";
import { apiGet, apiPost } from "@/lib/ui/api-client";

const CHUNK = 50;

interface Item {
  id: string;
  kind_label: string;
  title: string;
  month: string;
  summary: string;
  suggestion: string | null;
  confidence: "propose" | "unknown";
  count: number | null;
  identity_label: string | null;
}
interface PreviewRes {
  items: Item[];
  total: number;
}
interface BatchRes {
  batch_id: string;
  results: { id: string; status: "answered" | "skipped" | "error"; reason: string | null }[];
  counts: { answered: number; skipped: number; error: number };
}

export function BatchAcceptButton({ sessionId, month, disabled, onDone }: { sessionId?: string | null; month?: string; disabled?: boolean; onDone?: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [deadline, setDeadline] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIds = useRef<string[]>([]);

  const load = useCallback(async () => {
    const q = sessionId ? `session_id=${encodeURIComponent(sessionId)}` : month ? `month=${encodeURIComponent(month)}` : null;
    if (!q) return;
    const res = await apiGet<PreviewRes>(`/api/triage/questions/batch-accept/preview?${q}`);
    if (res.ok) setItems(res.data.items);
    else setItems([]);
  }, [sessionId, month]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const send = useCallback(async () => {
    timer.current = null;
    setDeadline(null);
    setSending(true);
    // 每個 request 最多 CHUNK 題（API 上限 50，逐題串行）；自動分批，彙總結果。任何一批整批失敗（例如已鎖月 403）就停低並顯示原因。
    const total = { answered: 0, skipped: 0, error: 0 };
    const reasons: string[] = [];
    for (let i = 0; i < pendingIds.current.length; i += CHUNK) {
      const res = await apiPost<BatchRes>("/api/triage/questions/batch-accept", { question_ids: pendingIds.current.slice(i, i + CHUNK) });
      if (!res.ok) {
        reasons.push(res.message);
        total.error += pendingIds.current.length - i;
        break;
      }
      total.answered += res.data.counts.answered;
      total.skipped += res.data.counts.skipped;
      total.error += res.data.counts.error;
      for (const r of res.data.results) if (r.status === "error" && r.reason) reasons.push(r.reason);
    }
    setSending(false);
    setSummary(`已答 ${total.answered}、跳過 ${total.skipped}、失敗 ${total.error}`);
    setErrors([...new Set(reasons)].slice(0, 5));
    await load();
    onDone?.();
  }, [load, onDone]);

  const confirm = () => {
    const ids = (items ?? []).filter((i) => picked.has(i.id)).map((i) => i.id);
    if (ids.length === 0) return;
    pendingIds.current = ids;
    setOpen(false);
    setSummary(null);
    setErrors([]);
    setDeadline(Date.now() + DEFERRED_UNDO_MS);
    timer.current = setTimeout(() => void send(), DEFERRED_UNDO_MS);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDeadline(null);
  };

  const n = items?.length ?? 0;
  if (n === 0 && !summary && errors.length === 0 && deadline === null && !sending) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="batch-accept">
      {n > 0 && deadline === null && !sending && (
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={() => {
            setPicked(new Set((items ?? []).filter((i) => i.confidence === "propose").map((i) => i.id))); // 把握低（unknown）嘅題預設唔剔
            setOpen(true);
          }}
          data-testid="batch-accept-open"
        >
          批量接受建議（{n} 題）
        </Button>
      )}
      {sending && <div className="text-zk-sm text-zk-muted" data-testid="batch-accept-sending">批量送出中…</div>}
      {deadline !== null && <UndoBar message={`即將批量接受 ${pendingIds.current.length} 題建議`} deadline={deadline} onUndo={undo} testId="batch-accept-undo-bar" />}
      {summary && (
        <div className="text-zk-sm font-semibold text-zk-text" data-testid="batch-accept-summary">
          {summary}
        </div>
      )}
      {errors.map((e, i) => (
        <div key={i} className="text-zk-xs text-zk-danger-dark" data-testid="batch-accept-error">
          {e}
        </div>
      ))}
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" data-testid="batch-accept-dialog">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative flex max-h-[85vh] w-full max-w-[640px] flex-col rounded-xl border border-zk-border bg-white p-5 shadow-xl">
            <h2 className="mb-1 text-zk-lg font-semibold text-zk-text">批量接受系統建議</h2>
            <p className="mb-3 text-zk-sm text-zk-muted">
              以下 {n} 題系統有預填建議答案。取消剔嘅題唔會處理。每題都會同單題「一撳確認」一樣先預覽再寫入；已鎖月份會整批拒絕。確認後有 5 秒可以撤銷，送出之後唔可以一鍵撤銷。
            </p>
            <div className="mb-2 flex items-center gap-3 text-zk-sm">
              <Button variant="link" size="sm" type="button" onClick={() => setPicked(new Set((items ?? []).filter((i) => i.confidence === "propose").map((i) => i.id)))}>
                全選有建議
              </Button>
              <Button variant="link" size="sm" type="button" onClick={() => setPicked(new Set())}>
                全不選
              </Button>
              <span className="ml-auto text-zk-muted">已選 {picked.size} 題</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto" data-testid="batch-accept-list">
              {(items ?? []).map((it) => (
                <label key={it.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-zk-border-soft px-3 py-2 text-zk-sm" data-testid="batch-accept-item">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(it.id)}
                    onChange={(e) =>
                      setPicked((p) => {
                        const next = new Set(p);
                        if (e.target.checked) next.add(it.id);
                        else next.delete(it.id);
                        return next;
                      })
                    }
                    aria-label={`接受 ${it.title}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <b className="text-zk-text">{it.title}</b>
                      <Pill variant="neutral">{it.kind_label}</Pill>
                      <Pill variant={it.confidence === "propose" ? "shift" : "warning"}>{it.confidence === "propose" ? "有建議" : "把握低"}</Pill>
                      {it.count !== null && <span className="text-zk-faint">{it.count} 更</span>}
                    </span>
                    <span className="block text-zk-text-secondary">{it.summary}</span>
                    {it.suggestion && <span className="block text-zk-primary-deep">建議：{it.suggestion}</span>}
                    {it.identity_label && <span className="block text-zk-muted">更表身份：{it.identity_label}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)} data-testid="batch-accept-cancel">
                取消
              </Button>
              <Button variant="primary" disabled={picked.size === 0} onClick={confirm} data-testid="batch-accept-confirm">
                確認接受 {picked.size} 題
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
