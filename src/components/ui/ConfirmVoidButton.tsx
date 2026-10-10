"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

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
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} className={className}>
        {label}
      </Button>
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
      <Button
        variant="dangerSolid"
        size="sm"
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
      >
        {busy ? busyLabel : confirmLabel}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(false);
          setReason("");
        }}
      >
        取消
      </Button>
    </div>
  );
}
