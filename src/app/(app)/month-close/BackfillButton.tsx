"use client";
// WP-POSTORDER-FREE（§34 D）：② 一鍵結算區「由 Postorder 補齊價目卡」——有該月 Postorder 上載先出；
// call POST /api/rate-cards/backfill-from-postorder，成功顯示「出咗 N 題，去待答問題 ›」。唔寫任何價（全部經待答問題確認）。
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/lib/ui/api-client";

interface BackfillRes {
  session_id: string | null;
  created: number;
  skipped_existing: number;
}

export function BackfillButton({ month, havePostorder, locked }: { month: string; havePostorder: boolean; locked: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; created?: number; pending?: number } | null>(null);
  if (!havePostorder) return null;
  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await apiPost<BackfillRes>("/api/rate-cards/backfill-from-postorder", { month });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.message });
      return;
    }
    setMsg({ kind: "ok", text: "", created: res.data.created, pending: res.data.skipped_existing });
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-zk-border-soft pt-2.5" data-testid="backfill-block">
      <Button variant="secondary" onClick={run} disabled={busy || locked} data-testid="backfill-from-postorder">
        {busy ? "補齊緊……" : "由 Postorder 補齊價目卡"}
      </Button>
      <span className="text-zk-xs text-zk-faint">一次過將自動卡／Postorder 價變成正式價目卡建議，逐題確認先生效，下個月唔使再靠 Postorder。</span>
      {msg?.kind === "err" && <span className="text-zk-sm text-zk-danger-dark">{msg.text}</span>}
      {msg?.kind === "ok" && (
        <span className="text-zk-sm text-zk-text-secondary" data-testid="backfill-result">
          {msg.created! > 0 ? `出咗 ${msg.created} 題，` : (msg.pending ?? 0) > 0 ? `冇新題（已有 ${msg.pending} 題待答或已處理），` : "冇需要補齊嘅價目卡，"}
          <Link href="/triage" className="text-zk-primary hover:underline">
            去待答問題 ›
          </Link>
        </span>
      )}
    </div>
  );
}
