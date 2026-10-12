"use client";
// P15.2：「平均工資與假期」tab——批量導入平均日薪（JSON／CSV）。預覽只顯示行號／工號，唔顯示姓名。
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/lib/ui/api-client";
import { parseBulkText, AVG_WAGE_BULK_OPTS } from "@/lib/longterm-payroll/bulk-parse";

interface Preview {
  total: number;
  matched: number;
  created: number;
  updated: number;
  skipped_unchanged: number;
  unmatched: { row: number; reason: string; staff_no?: string }[];
  invalid: { row: number; reason: string }[];
}
const REASON_LABEL: Record<string, string> = { no_match: "配唔到", ambiguous: "多過一人", no_identifier: "冇工號／英文名" };

export function BulkAvgWagesPanel({ month, locked, onChanged, onError, onNotice }: { month: string; locked: boolean; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File | null) {
    setPreview(null);
    setRows(null);
    if (!f) return;
    const { rows: parsed, error } = parseBulkText(f.name, await f.text(), AVG_WAGE_BULK_OPTS);
    if (error) return onError(error);
    if (parsed.length === 0) return onError("檔案冇任何資料行");
    if (parsed.length > 500) return onError(`一次最多 500 行（呢個檔有 ${parsed.length} 行），請分檔`);
    setFileName(f.name);
    setRows(parsed);
    setBusy(true);
    const res = await apiPost<Preview>(`/api/longterm/avg-wages/bulk?dry_run=1`, { month: `${month}-01`, rows: parsed });
    setBusy(false);
    if (res.ok) setPreview(res.data);
    else onError(res.message);
  }

  async function confirm() {
    if (!rows) return;
    setBusy(true);
    const res = await apiPost<Preview>(`/api/longterm/avg-wages/bulk`, { month: `${month}-01`, rows });
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`平均工資批量導入完成：新增 ${res.data.created}、更新 ${res.data.updated}、無變化 ${res.data.skipped_unchanged}、配唔到 ${res.data.unmatched.length}、資料有問題 ${res.data.invalid.length}`);
    setRows(null);
    setPreview(null);
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
    onChanged();
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-avgbulk-panel">
      <div className="text-sm font-semibold text-zk-text">批量導入平均工資（{month}）</div>
      <p className="text-zk-sm text-zk-muted">上載 JSON 或 CSV（欄：staff_no／staff_no_mw／name_en／avg_daily_wage／note；每次最多 500 行）。同一人同月同金額重做會自動略過。</p>
      {locked ? (
        <div className="text-zk-sm text-zk-muted">呢個月已鎖定，唔可以導入</div>
      ) : (
        <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} data-testid="ltpay-avgbulk-file" aria-label="平均工資批量導入檔案" />
      )}
      {preview && (
        <div className="flex flex-col gap-2 rounded border border-zk-border-soft p-3 text-zk-sm" data-testid="ltpay-avgbulk-preview">
          <div>
            {fileName}：共 {preview.total} 行，配到 {preview.matched} 行；預計新增 {preview.created}、更新 {preview.updated}、無變化 {preview.skipped_unchanged}。
          </div>
          {preview.unmatched.length > 0 && (
            <div className="text-zk-danger">
              配唔到 {preview.unmatched.length} 行：{preview.unmatched.slice(0, 30).map((u) => `第 ${u.row} 行${u.staff_no ? `（${u.staff_no}）` : ""}${REASON_LABEL[u.reason] ? `〔${REASON_LABEL[u.reason]}〕` : ""}`).join("、")}
              {preview.unmatched.length > 30 ? "…" : ""}
            </div>
          )}
          {preview.invalid.length > 0 && <div className="text-zk-danger">資料有問題 {preview.invalid.length} 行：{preview.invalid.slice(0, 30).map((o) => `第 ${o.row} 行（${o.reason}）`).join("、")}</div>}
          <div>
            <Button variant="primary" onClick={confirm} disabled={busy || preview.created + preview.updated === 0} data-testid="ltpay-avgbulk-confirm">
              確認寫入 {preview.created + preview.updated} 行
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
