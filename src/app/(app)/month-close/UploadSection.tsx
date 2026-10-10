"use client";
// 1a ① 上載：三行 grid `200px 1fr auto`——狀態一句＋掣；原長篇 Postorder 說明收入「睇點樣匯出 CSV ›」。
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import type { UploadRow } from "@/components/month-close/derive";

const pickCls = "inline-flex cursor-pointer items-center rounded-md border border-zk-input-border bg-white px-3.5 py-[7px] text-zk-base text-zk-text-secondary transition-colors hover:bg-zk-header focus-within:ring-2 focus-within:ring-zk-primary";

function Row({ row, children, extra }: { row: UploadRow; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-zk-border-soft px-4 py-3 lg:grid-cols-[200px_minmax(0,1fr)_auto]" data-upload={row.key}>
      <div>
        <div className="text-zk-base font-medium text-zk-text">{row.name}</div>
        <div className="text-zk-xs text-zk-faint">{row.hint}</div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-zk-sm text-zk-text-secondary">
        <span className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full text-zk-xs font-bold ${row.have ? "bg-zk-success-tint text-zk-success" : "bg-zk-surface text-zk-faint"}`}>{row.have ? "✓" : "–"}</span>
        <span className="min-w-0 break-words">
          {row.status}
          {extra}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function UploadSection(props: {
  rows: UploadRow[];
  month: string;
  busy: boolean;
  disabled: boolean;
  jobRunning: boolean;
  rosterFiles: FileList | null;
  staffListFile: File | null;
  postorderFiles: File[];
  onRosterFiles: (f: FileList | null) => void;
  onStaffListFile: (f: File | null) => void;
  onPostorderFiles: (f: File[]) => void;
  onUploadRosters: () => void;
  onUploadStaffList: () => void;
  onUploadPostorder: () => void;
}) {
  const { rows, busy, disabled } = props;
  const roster = rows.find((r) => r.key === "roster")!;
  const staff = rows.find((r) => r.key === "staff_list")!;
  const post = rows.find((r) => r.key === "postorder")!;
  const nRoster = props.rosterFiles?.length ?? 0;
  const allHave = roster.have && staff.have;
  // P3-4.4：手機（<lg）更表同名單都有就收起（要上載先展開），少佔一屏。
  const [mobileOpen, setMobileOpen] = useState(false);
  const bodyCls = allHave && !mobileOpen ? "max-lg:hidden" : "";
  return (
    <section className="overflow-hidden rounded-[10px] border border-zk-border bg-white" data-testid="upload-section">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-zk-border-soft px-4 py-3">
        <h2 className="text-zk-md font-semibold text-zk-text">① 上載</h2>
        <span className={`ml-auto text-zk-sm ${allHave ? "text-zk-success" : "text-zk-muted"}`}>{allHave ? "更表同名單都有，可以結算" : "更表同 U Team 名單上載咗先可以結算"}</span>
        {allHave && (
          <Button variant="link" size="sm" className="lg:hidden" onClick={() => setMobileOpen((v) => !v)} aria-expanded={mobileOpen} data-testid="upload-toggle">
            {mobileOpen ? "收埋 ‹" : "展開 ›"}
          </Button>
        )}
      </div>
      <div className={bodyCls}>
      {props.jobRunning && <div className="border-b border-zk-border-soft px-4 py-2 text-zk-sm text-zk-warning">一鍵結算執行緊——完成之前唔可以再上載</div>}

      <Row row={roster} extra={nRoster > 0 ? <span className="ml-2 text-zk-primary">已揀 {nRoster} 檔，撳右邊上載</span> : null}>
        <label className={`${pickCls} ${disabled ? "pointer-events-none opacity-[.45]" : ""}`}>
          {roster.have ? "加上載" : "揀更表"}
          <input type="file" multiple accept=".xlsx" data-testid="month-close-roster-file-input" className="sr-only" disabled={disabled} onChange={(e) => props.onRosterFiles(e.target.files)} />
        </label>
        {nRoster > 0 && (
          <Button variant="primary" onClick={props.onUploadRosters} disabled={busy || disabled}>
            上載更表（{nRoster} 檔）
          </Button>
        )}
        <Link href={`/roster-uploads?month=${props.month}`} className="px-1 text-zk-sm text-zk-primary hover:underline">
          去更表上載 ›
        </Link>
      </Row>

      <Row row={staff} extra={props.staffListFile ? <span className="ml-2 text-zk-primary">已揀 {props.staffListFile.name}</span> : null}>
        <label className={`${pickCls} ${disabled ? "pointer-events-none opacity-[.45]" : ""}`}>
          {staff.have ? "換一份" : "揀名單"}
          <input type="file" accept=".xlsx" data-testid="month-close-staff-list-file-input" className="sr-only" disabled={disabled} onChange={(e) => props.onStaffListFile(e.target.files?.[0] ?? null)} />
        </label>
        {props.staffListFile && (
          <Button variant="primary" onClick={props.onUploadStaffList} disabled={busy || disabled}>
            上載名單
          </Button>
        )}
      </Row>

      <Row row={post} extra={props.postorderFiles.length > 0 ? <span className="ml-2 text-zk-primary">已揀 {props.postorderFiles.length} 檔</span> : null}>
        <label className={`${pickCls} ${disabled ? "pointer-events-none opacity-[.45]" : ""}`}>
          {post.have ? "換一份" : "揀總表"}
          <input type="file" multiple accept=".xlsm,.xlsx,.csv" data-testid="month-close-postorder-file-input" className="sr-only" disabled={disabled} onChange={(e) => props.onPostorderFiles(Array.from(e.target.files ?? []))} />
        </label>
        {props.postorderFiles.length > 0 && (
          <Button variant="primary" onClick={props.onUploadPostorder} disabled={busy || disabled}>
            上載總表
          </Button>
        )}
      </Row>

      <div className="border-b border-zk-border-soft px-4 py-2 text-zk-xs text-zk-muted" data-testid="upload-section-hint">
        亦可以喺「對數 › 更表上載」逐盤上載同對數。
      </div>

      <details className="bg-zk-header px-4 py-2.5 text-zk-xs text-zk-muted">
        <summary className="cursor-pointer">
          Postorder 只係 8、9 月過渡對照用。正式站讀唔到 .xlsm？<span className="text-zk-primary">睇點樣匯出 CSV ›</span>
        </summary>
        <div className="mt-2 leading-relaxed text-zk-faint">
          §20.5：系統本身已經係總表，Postorder 純粹俾 8、9 月過渡對照用——以後淨係長工崗位盤／介紹雞頭要以系統資料為準。請將 Roster 同 PostOrder 兩個分頁另存做 CSV 上載（Google Sheets：檔案 → 下載 → 逗號分隔值）：PostOrder.csv（可另加 longterm-pairs.csv 或 Roster.csv）。.xlsm／.xlsx 大過 1.5MB 會被拒絕（會令伺服器爆記憶體）。
        </div>
      </details>
      </div>
    </section>
  );
}
