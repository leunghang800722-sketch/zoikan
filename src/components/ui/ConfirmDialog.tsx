"use client";
// P3-4.2：通用確認框（取代 `window.confirm`）。
// 用法：const { confirm, dialog } = useConfirm(); … if (!(await confirm({ message: "…", confirmLabel: "確定" }))) return; … JSX 入面放 {dialog}。
// 作廢類（要填原因）用 `ConfirmVoidButton`；可撤銷類用 UndoBar。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";

export interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger＝確認掣紅色（刪除類）。 */
  tone?: "default" | "danger";
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "確定",
  cancelLabel = "取消",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="alertdialog" aria-modal="true" data-testid="confirm-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-full max-w-[420px] rounded-xl border border-zk-border bg-white p-5 shadow-xl">
        {title && <h2 className="mb-2 text-zk-lg font-semibold text-zk-text">{title}</h2>}
        <div className="whitespace-pre-wrap text-zk-md text-zk-text-secondary" data-testid="confirm-dialog-message">{message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} data-testid="confirm-dialog-cancel">
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "dangerSolid" : "primary"} onClick={onConfirm} data-testid="confirm-dialog-ok" autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function useConfirm(): { confirm: (o: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const finish = useCallback((v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  }, []);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpts(o);
      }),
    [],
  );
  const dialog = opts ? <ConfirmDialog open {...opts} onConfirm={() => finish(true)} onCancel={() => finish(false)} /> : null;
  return { confirm, dialog };
}
