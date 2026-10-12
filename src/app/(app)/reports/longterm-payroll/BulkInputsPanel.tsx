"use client";
// P14.2：「人手輸入」tab——批量導入（JSON／CSV）＋「由更表生成草稿」。預覽只顯示行號／工號，唔顯示姓名。
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/lib/ui/api-client";
import { parseBulkText } from "@/lib/longterm-payroll/bulk-parse";

interface Preview {
  dry_run: boolean;
  total: number;
  matched: number;
  created: number;
  skipped_duplicate: number;
  unmatched: { row: number; reason: string; staff_no?: string }[];
  overlaps: { row: number; reason: string }[];
  invalid: { row: number; reason: string }[];
}
const REASON_LABEL: Record<string, string> = { no_match: "配唔到", ambiguous: "多過一人", no_identifier: "冇工號／英文名" };

export function BulkInputsPanel({ month, locked, onChanged, onError, onNotice }: { month: string; locked: boolean; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File | null) {
    setPreview(null);
    setRows(null);
    if (!f) return;
    const { rows: parsed, error } = parseBulkText(f.name, await f.text());
    if (error) return onError(error);
    if (parsed.length === 0) return onError("檔案冇任何資料行");
    if (parsed.length > 500) return onError(`一次最多 500 行（呢個檔有 ${parsed.length} 行），請分檔`);
    setFileName(f.name);
    setRows(parsed);
    setBusy(true);
    const res = await apiPost<Preview>(`/api/longterm/inputs/bulk?dry_run=1`, { month: `${month}-01`, rows: parsed });
    setBusy(false);
    if (res.ok) setPreview(res.data);
    else onError(res.message);
  }

  async function confirm() {
    if (!rows) return;
    setBusy(true);
    const res = await apiPost<Preview>(`/api/longterm/inputs/bulk`, { month: `${month}-01`, rows });
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`批量導入完成：新增 ${res.data.created}、重複略過 ${res.data.skipped_duplicate}、配唔到 ${res.data.unmatched.length}、重疊 ${res.data.overlaps.length}`);
    setRows(null);
    setPreview(null);
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
    onChanged();
  }

  async function generate() {
    setBusy(true);
    const res = await apiPost<{ draft: { created: number; updated: number; voided: number; pending: number; locked: boolean }; cover: { created: number; updated: number } | null }>(`/api/longterm/inputs/drafts/generate?month=${month}`);
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`已由更表生成草稿：病假草稿新增 ${res.data.draft.created}、更新 ${res.data.draft.updated}、待確認 ${res.data.draft.pending}；頂位草稿新增 ${res.data.cover?.created ?? 0}`);
    onChanged();
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-bulk-panel">
      <div className="text-sm font-semibold text-zk-text">批量導入人手輸入／生成草稿</div>
      <p className="text-zk-sm text-zk-muted">
        上載 JSON 或 CSV（欄：staff_no／staff_no_mw／name_en／kind／amount／date_from／date_to／doctor_note_verified／note；每次最多 500 行）。同一人同種類同金額同日期已存在會自動略過，重做唔會重複。寫入後即已確認。
      </p>
      {locked ? (
        <div className="text-zk-sm text-zk-muted">呢個月已鎖定，唔可以導入或生成</div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} data-testid="ltpay-bulk-file" aria-label="批量導入檔案" />
          <Button variant="secondary" onClick={generate} disabled={busy} data-testid="ltpay-generate-drafts">
            由更表生成草稿（老闆）
          </Button>
        </div>
      )}
      {preview && (
        <div className="flex flex-col gap-2 rounded border border-zk-border-soft p-3 text-zk-sm" data-testid="ltpay-bulk-preview">
          <div>
            {fileName}：共 {preview.total} 行，配到 {preview.matched} 行；預計新增 {preview.created}、重複略過 {preview.skipped_duplicate}。
          </div>
          {preview.unmatched.length > 0 && (
            <div className="text-zk-danger">
              配唔到 {preview.unmatched.length} 行：{preview.unmatched.slice(0, 30).map((u) => `第 ${u.row} 行${u.staff_no ? `（${u.staff_no}）` : ""}${REASON_LABEL[u.reason] ? `〔${REASON_LABEL[u.reason]}〕` : ""}`).join("、")}
              {preview.unmatched.length > 30 ? "…" : ""}
            </div>
          )}
          {preview.overlaps.length > 0 && <div className="text-zk-danger">病假段重疊已確認段 {preview.overlaps.length} 行：{preview.overlaps.slice(0, 30).map((o) => `第 ${o.row} 行`).join("、")}（唔會寫入）</div>}
          {preview.invalid.length > 0 && <div className="text-zk-danger">資料有問題 {preview.invalid.length} 行：{preview.invalid.slice(0, 30).map((o) => `第 ${o.row} 行（${o.reason}）`).join("、")}</div>}
          <div>
            <Button variant="primary" onClick={confirm} disabled={busy || preview.created === 0} data-testid="ltpay-bulk-confirm">
              確認寫入 {preview.created} 行
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
