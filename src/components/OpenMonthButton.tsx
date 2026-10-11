"use client";
// P7.2：手動「開新月」入口（排程每月 25 號自動做；呢度係補開／提早開）。
// call 同一個 `POST /api/months/:month/open`（冪等：複製掛盤／配額／每日需求，已存在嘅唔重複寫；已鎖月 403）。
import { useState } from "react";
import { apiPost } from "@/lib/ui/api-client";
import { addMonthsStr, currentMonthStr } from "@/lib/ui/format";
import { Button } from "@/components/ui/Button";
import { MonthPicker } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";

interface OpenResult {
  month: string;
  source_month: string;
  broker_site_assignments_created: number;
  quotas_created: number;
  daily_requirements_created: number;
  already_open: boolean;
}

export function OpenMonthButton({ onDone }: { onDone?: (message: string) => void }) {
  const [month, setMonth] = useState(() => addMonthsStr(currentMonthStr(), 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function open() {
    if (busy) return;
    setError(null);
    const prev = addMonthsStr(month, -1);
    const ok = await confirm({ message: `開 ${month}：由 ${prev} 複製雞頭掛盤、配額、每日需求。已存在嘅唔會重複寫，可以安全重跑。\n（價目卡請喺「價目」頁用「複製上月卡到本月」預覽確認。）`, confirmLabel: "開新月" });
    if (!ok) return;
    setBusy(true);
    const res = await apiPost<OpenResult>(`/api/months/${month}/open`, {});
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const d = res.data;
    onDone?.(d.already_open ? `${month} 已經開咗，冇新增。` : `${month} 已開好：掛盤 ${d.broker_site_assignments_created}／配額 ${d.quotas_created}／每日需求 ${d.daily_requirements_created}。`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="open-month">
      <MonthPicker value={month} onChange={setMonth} label="開新月" testId="open-month-input" ariaLabel="開新月份" />
      <Button variant="secondary" onClick={open} disabled={busy} data-testid="open-month-button">
        {busy ? "開緊…" : "開新月"}
      </Button>
      {error && (
        <span role="alert" data-testid="open-month-error" className="text-zk-sm text-zk-danger">
          {error}
        </span>
      )}
      {dialog}
    </div>
  );
}
