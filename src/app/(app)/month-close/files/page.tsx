"use client";
// P8.3：鎖月後自動生成嘅檔案（糧明細／月結總表／Postorder／BOCHK autopay）。清單＋下載。
// BOCHK autopay 入銀行前仍要人覆核：下載前彈確認（沿用原匯出 route 嘅 confirm_locked=1 閘）。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { MonthPicker, useMonthState } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/DataTable";
import { apiGet } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";
import { formatHkTime } from "@/components/home/HomeNotifications";

interface FileRow {
  id: string;
  month: string;
  kind: string;
  kind_label: string;
  filename: string;
  size: number;
  generated_at: string;
  current: boolean;
  needs_confirm: boolean;
}

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function GeneratedFilesPage() {
  const [month, setMonth, ready] = useMonthState();
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    const res = await apiGet<{ files: FileRow[] }>(`/api/files?month=${month}`);
    if (!res.ok) {
      setError(res.message);
      setFiles([]);
      return;
    }
    setError(null);
    setFiles(res.data.files);
  }, [month]);
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  async function download(f: FileRow) {
    if (f.needs_confirm) {
      const okay = await confirm({ title: "下載 BOCHK autopay 檔", message: "呢份係入銀行出糧用嘅檔。入銀行前請先人手覆核金額同收款戶口，並確認呢個月未出過糧。", confirmLabel: "我已知道，下載" });
      if (!okay) return;
    }
    window.location.href = `/api/files/${f.id}${f.needs_confirm ? "?confirm_locked=1" : ""}`;
  }

  const current = (files ?? []).filter((f) => f.current);
  const older = (files ?? []).filter((f) => !f.current);
  return (
    <div className="flex flex-col gap-4" data-testid="generated-files-page">
      {dialog}
      <PageHeader
        kicker={kickerFor("/month-close/files")}
        title="已生成檔案"
        subtitle="月份鎖定後系統自動備妥嘅糧明細、月結總表、Postorder 格式總表同 BOCHK autopay 檔。內容同你手動匯出一樣。"
        actions={
          <>
            <MonthPicker value={month} onChange={setMonth} testId="files-month-input" />
            <Link href={`/month-close?month=${month}`}>
              <Button variant="secondary">返回一鍵結算</Button>
            </Link>
          </>
        }
      />
      <Banner kind="error" message={error} />
      {files && files.length === 0 && !error && <EmptyState title="呢個月未有自動生成嘅檔案" description="月份鎖定後約 5 分鐘內會自動生成（未鎖月份唔會出檔）。" />}
      {current.length > 0 && (
        <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
          {current.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-3 border-b border-zk-border-soft px-4 py-3 last:border-b-0" data-testid="generated-file-row" data-kind={f.kind}>
              <div className="min-w-0 flex-1">
                <div className="text-zk-base font-semibold text-zk-text">{f.kind_label}</div>
                <div className="text-zk-sm text-zk-muted">
                  {f.filename} · {fmtSize(f.size)} · 生成於 {formatHkTime(f.generated_at)}
                </div>
              </div>
              {f.needs_confirm && <Pill variant="warning">入銀行前要人覆核</Pill>}
              <Button variant="primary" size="sm" onClick={() => void download(f)} data-testid="generated-file-download">
                下載
              </Button>
            </div>
          ))}
        </div>
      )}
      {older.length > 0 && (
        <details className="text-zk-sm text-zk-muted" data-testid="generated-files-older">
          <summary className="cursor-pointer">上一版（重新鎖月前生成，各保留 1 份）</summary>
          <div className="mt-2 overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {older.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-3 border-b border-zk-border-soft px-4 py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  {f.kind_label} · {f.filename} · {formatHkTime(f.generated_at)}
                </div>
                <Button variant="secondary" size="sm" onClick={() => void download(f)}>
                  下載
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
