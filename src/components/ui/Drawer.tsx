"use client";
import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";

export function Drawer({
  open,
  title,
  onClose,
  children,
  widthClassName = "w-[420px]",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string;
}) {
  // P13.5：開 Drawer 入 history，返回（Android 系統返回／手勢）只關 Drawer
  const { close } = useHistoryOverlay(open, onClose, `drawer-${useId()}`);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={close} />
      <div className={`relative z-50 flex h-full ${widthClassName} flex-col overflow-y-auto border-l border-zk-border bg-white p-5 shadow-xl`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={close}>
            關閉
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
