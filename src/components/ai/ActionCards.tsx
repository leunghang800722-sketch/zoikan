"use client";
// WP-AI-DIAG（§37.4／2.5）：助手回覆下面嘅「建議動作卡」。
//
// - 白名單以外嘅 type／格式唔啱嘅卡前端再擋一次（`sanitizeActionCards()`，同 server 同一份 schema）。
// - `open_page`＝內部連結。
// - 寫入卡＝「會做乜」＋「依據」＋掣；撳掣 → 5 秒撤銷條 → 5 秒後先經**現有** API 真正送出（request 同人手操作一字不差，
//   見 src/lib/ui/ai-action-requests.ts）。5 秒內撤銷＝完全唔發 request。
// - `triage_answer`：先 call 現有 preview endpoint，卡上顯示影響摘要，再撳「確認」先入 5 秒撤銷 → answer（帶 preview_hash）。
// - 成功：卡標「已做」＋ `onDone(label)`（側欄本地加一條備註，純前端）；失敗：顯示 API 回傳 message。
// - 元件卸載（例如側欄收埋）＝取消未送出嘅倒數，唔會靜靜送出用戶睇唔到嘅寫入。
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { sanitizeActionCards, type ActionCard } from "@/lib/ai/actions";
import { DEFERRED_UNDO_MS } from "@/components/month-close/deferred";
import { UndoBar } from "@/components/ui/UndoBar";
import { describeAction, requestForAction, runSpec, triageAnswerRequest, triagePreviewRequest } from "@/lib/ui/ai-action-requests";

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "previewed"; summary: string[]; hash: string }
  | { kind: "pending"; deadline: number }
  | { kind: "sending" }
  | { kind: "done" }
  | { kind: "error"; message: string };

interface PreviewData {
  preview_hash: string;
  impact?: { summary?: unknown };
}

function ActionCardView({ card, onDone }: { card: ActionCard; onDone?: (label: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hashRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const schedule = useCallback((send: () => Promise<void>) => {
    if (timer.current) clearTimeout(timer.current);
    setPhase({ kind: "pending", deadline: Date.now() + DEFERRED_UNDO_MS });
    timer.current = setTimeout(() => {
      timer.current = null;
      void send();
    }, DEFERRED_UNDO_MS);
  }, []);

  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPhase(card.type === "triage_answer" && hashRef.current ? { kind: "previewed", summary: [], hash: hashRef.current } : { kind: "idle" });
  }, [card.type]);

  const finish = useCallback(
    (ok: true | { message: string }) => {
      if (ok === true) {
        setPhase({ kind: "done" });
        onDone?.(card.label);
      } else {
        setPhase({ kind: "error", message: ok.message });
      }
    },
    [card.label, onDone],
  );

  const sendWrite = useCallback(async () => {
    const spec = requestForAction(card);
    if (!spec) return;
    setPhase({ kind: "sending" });
    const res = await runSpec(spec);
    finish(res.ok ? true : { message: res.message });
  }, [card, finish]);

  const startPreview = useCallback(async () => {
    if (card.type !== "triage_answer") return;
    setPhase({ kind: "previewing" });
    const res = await runSpec<PreviewData>(triagePreviewRequest(card));
    if (!res.ok) {
      setPhase({ kind: "error", message: res.message });
      return;
    }
    hashRef.current = res.data.preview_hash;
    const summary = Array.isArray(res.data.impact?.summary) ? (res.data.impact!.summary as unknown[]).filter((x): x is string => typeof x === "string") : [];
    setPhase({ kind: "previewed", summary, hash: res.data.preview_hash });
  }, [card]);

  const confirmTriage = useCallback(
    (hash: string) => {
      if (card.type !== "triage_answer") return;
      schedule(async () => {
        setPhase({ kind: "sending" });
        const res = await runSpec(triageAnswerRequest(card, hash));
        if (!res.ok) {
          hashRef.current = null;
          finish({ message: res.status === 409 ? `${res.message}（請再撳「預覽影響」）` : res.message });
          return;
        }
        finish(true);
      });
    },
    [card, schedule, finish],
  );

  if (card.type === "open_page") {
    return (
      <div className="rounded-lg border border-zk-border bg-white px-3 py-2 text-zk-sm" data-testid="ai-action-card" data-action-type="open_page">
        <div className="font-semibold text-zk-text">{card.label}</div>
        <div className="mt-0.5 text-zk-xs text-zk-muted">依據：{card.basis}</div>
        <Link href={card.params.href} className="mt-1.5 inline-block text-zk-sm font-semibold text-zk-primary hover:underline" data-testid="ai-action-open-page">
          打開頁面 ›
        </Link>
      </div>
    );
  }

  const busy = phase.kind === "previewing" || phase.kind === "pending" || phase.kind === "sending";
  return (
    <div className="rounded-lg border border-zk-border bg-white px-3 py-2 text-zk-sm" data-testid="ai-action-card" data-action-type={card.type}>
      <div className="font-semibold text-zk-text">{card.label}</div>
      <div className="mt-0.5 text-zk-xs text-zk-text-secondary" data-testid="ai-action-what">
        會做乜：{describeAction(card)}
      </div>
      <div className="mt-0.5 text-zk-xs text-zk-muted" data-testid="ai-action-basis">
        依據：{card.basis}
      </div>

      {phase.kind === "previewed" && (
        <div className="mt-1.5 rounded bg-zk-surface px-2 py-1.5 text-zk-xs text-zk-text-secondary" data-testid="ai-action-impact">
          {phase.summary.length ? phase.summary.map((s, i) => <div key={i}>{s}</div>) : <div>預覽完成（冇額外影響摘要）</div>}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {phase.kind === "done" ? (
          <span className="text-zk-sm font-semibold text-[#15803d]" data-testid="ai-action-done">
            已做
          </span>
        ) : card.type === "triage_answer" ? (
          phase.kind === "previewed" ? (
            <button type="button" onClick={() => confirmTriage(phase.hash)} className="rounded-md bg-zk-primary px-2.5 py-1 text-zk-sm font-semibold text-white" data-testid="ai-action-confirm">
              確認
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void startPreview()} className="rounded-md bg-zk-primary px-2.5 py-1 text-zk-sm font-semibold text-white disabled:opacity-50" data-testid="ai-action-preview">
              {phase.kind === "previewing" ? "預覽緊…" : "預覽影響"}
            </button>
          )
        ) : (
          <button type="button" disabled={busy} onClick={() => schedule(sendWrite)} className="rounded-md bg-zk-primary px-2.5 py-1 text-zk-sm font-semibold text-white disabled:opacity-50" data-testid="ai-action-run">
            {phase.kind === "sending" ? "送出中…" : "執行"}
          </button>
        )}
      </div>

      {phase.kind === "pending" && (
        <div className="mt-1.5">
          <UndoBar message={`即將執行：${card.label}`} deadline={phase.deadline} onUndo={undo} testId="ai-action-undo-bar" />
        </div>
      )}
      {phase.kind === "error" && (
        <div className="mt-1.5 text-zk-sm text-zk-danger-dark" data-testid="ai-action-error">
          {phase.message}
        </div>
      )}
    </div>
  );
}

export function ActionCards({ actions, onDone }: { actions: unknown; onDone?: (label: string) => void }) {
  const cards = sanitizeActionCards(actions);
  if (cards.length === 0) return null;
  return (
    <div className="mt-1.5 flex max-w-[86%] flex-col gap-1.5" data-testid="ai-action-cards">
      {cards.map((c, i) => (
        <ActionCardView key={`${i}-${c.type}`} card={c} onDone={onDone} />
      ))}
    </div>
  );
}
