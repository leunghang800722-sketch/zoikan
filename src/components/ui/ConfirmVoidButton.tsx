"use client";
import { useState } from "react";

/** 作廢/退回用嘅行內二次確認按鈕——強制要求填 reason，唔用 window.confirm()。 */
export function ConfirmVoidButton({
  label = "作廢",
  confirmLabel = "確認作廢",
  busyLabel = "處理中…",
  onConfirm,
  className = "",
}: {
  label?: string;
  confirmLabel?: string;
  busyLabel?: string;
  onConfirm: (reason: string) => Promise<void> | void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded border border-zk-danger-border px-2 py-1 text-xs text-zk-danger-dark hover:bg-zk-danger-bg ${className}`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="填原因先可以確認"
        className="w-40 rounded border border-zk-input-border px-2 py-1 text-xs"
      />
      <button
        type="button"
        disabled={busy || !reason.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm(reason.trim());
            setOpen(false);
            setReason("");
          } finally {
            setBusy(false);
          }
        }}
        className="rounded bg-zk-danger px-2 py-1 text-xs text-white disabled:opacity-50"
      >
        {busy ? busyLabel : confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setReason("");
        }}
        className="rounded px-2 py-1 text-xs text-zk-muted hover:bg-zk-surface"
      >
        取消
      </button>
    </div>
  );
}
