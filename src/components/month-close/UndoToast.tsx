"use client";
// 答題後 5 秒撤銷 toast（桌面對話框／手機 1e 共用）：已確認／已跳過「題目」· 撤銷，附倒數條同秒數。
import { useEffect, useState } from "react";
import { humanize } from "./derive";
import { DEFERRED_UNDO_MS, type DeferredItem } from "./deferred";

export function UndoToast({ item, deadline, onUndo, className }: { item: DeferredItem; deadline: number; onUndo: () => void; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [deadline]);
  const remain = Math.max(0, deadline - now);
  return (
    <div className={`overflow-hidden rounded-xl bg-[#0f172a] text-white shadow-[0_8px_24px_rgba(0,0,0,.25)] ${className ?? ""}`} role="status" data-testid="mc-undo-toast">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="min-w-0 flex-1 text-[13px] leading-snug">
          {item.kind === "skip" ? "已跳過" : "已確認"}「{humanize(item.title)}」<span className="ml-1 text-[11.5px] text-[#94a3b8]">送出中（可撤銷）· {Math.ceil(remain / 1000)}</span>
        </span>
        <button type="button" onClick={onUndo} className="text-[13px] font-semibold text-[#93c5fd]" data-testid="mc-undo">
          撤銷
        </button>
      </div>
      <div className="h-[3px] bg-[#1e293b]">
        <div className="h-full bg-[#93c5fd]" style={{ width: `${(remain / DEFERRED_UNDO_MS) * 100}%` }} />
      </div>
    </div>
  );
}
