"use client";
// WP-AI-DIAG：通用「5 秒撤銷」條（助手建議動作卡用）。沿用月結頁 `UndoToast` 同一個倒數時長常數（DEFERRED_UNDO_MS）同外觀，
// 但唔綁 `DeferredItem`（月結頁行為不變）。倒數由 caller 持有 deadline；時間到先由 caller 真正發 request。
import { useEffect, useState } from "react";
import { DEFERRED_UNDO_MS } from "@/components/month-close/deferred";

export function UndoBar({ message, deadline, onUndo, testId }: { message: string; deadline: number; onUndo: () => void; testId?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [deadline]);
  const remain = Math.max(0, deadline - now);
  return (
    <div className="overflow-hidden rounded-xl bg-[#0f172a] text-white" role="status" data-testid={testId ?? "undo-bar"}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
          {message}
          <span className="ml-1 text-[11px] text-[#94a3b8]">送出中（可撤銷）· {Math.ceil(remain / 1000)}</span>
        </span>
        <button type="button" onClick={onUndo} className="text-[12.5px] font-semibold text-[#93c5fd]" data-testid="undo-bar-undo">
          撤銷
        </button>
      </div>
      <div className="h-[3px] bg-[#1e293b]">
        <div className="h-full bg-[#93c5fd]" style={{ width: `${(remain / DEFERRED_UNDO_MS) * 100}%` }} />
      </div>
    </div>
  );
}
