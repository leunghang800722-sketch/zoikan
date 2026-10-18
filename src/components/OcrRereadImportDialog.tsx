"use client";
// TR-1：分診 session 卡「⋯」→「導入 OCR 重讀建議」。上載本機 19-triage-reread.ts 出嘅 proposals.json →
// 先 dry run（淨計數，唔寫）→ 確認套用（逐題經現有預覽＝寫入路徑答）。回應只有計數，唔顯示任何欄位值。375px 單欄。
import { useRef, useState } from "react";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { apiPost } from "@/lib/ui/api-client";

interface Counts {
  dry_run: boolean;
  proposals_total: number;
  matched_questions: number;
  applied: number;
  skipped_no_question: number;
  skipped_kind: number;
  skipped_field_mismatch: number;
  skipped_invalid: number;
  skipped_restricted: number;
  skipped_partial: number;
  errors: number;
  /** TR-2（additive，舊 server 冇） */
  applied_partial?: number;
  follow_up_created?: number;
  /** TE-4（additive，舊 server 冇） */
  skipped_low_confidence?: number;
  skipped_identity_mismatch?: number;
  /** TE-5 */
  skipped_needs_decision?: number;
}
const SKIP_LABEL: [keyof Counts, string][] = [
  ["skipped_no_question", "冇對應未答題"],
  ["skipped_kind", "題目類別唔處理"],
  ["skipped_field_mismatch", "欄位／值對唔上"],
  ["skipped_invalid", "格式或預覽唔通過"],
  ["skipped_restricted", "冇權限"],
  ["skipped_partial", "只有部分欄有建議"],
  ["skipped_low_confidence", "低信心（印刷冇卡／同卡唔一致），留人手"],
  ["skipped_identity_mismatch", "身份對唔上（號碼已屬他人等）"],
  ["skipped_needs_decision", "要人決定連結／建新人"],
  ["errors", "出錯"],
];

export function OcrRereadImportDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const { close } = useHistoryOverlay(true, onClose, `ocr-reread-${sessionId}`);
  const body = useRef<unknown>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dry, setDry] = useState<Counts | null>(null);
  const [done, setDone] = useState<Counts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(f: File | null) {
    setDry(null);
    setDone(null);
    setError(null);
    body.current = null;
    setFileName(f ? f.name : null);
    if (!f) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      setError("唔係有效嘅 JSON 檔");
      return;
    }
    body.current = parsed;
    setBusy(true);
    const res = await apiPost<Counts>(`/api/triage/sessions/${sessionId}/proposals?dry_run=1`, parsed);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDry(res.data);
  }

  async function apply() {
    if (!body.current) return;
    setBusy(true);
    setError(null);
    const res = await apiPost<Counts>(`/api/triage/sessions/${sessionId}/proposals`, body.current);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDone(res.data);
    onDone();
  }

  const shown = done ?? dry;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="導入 OCR 重讀建議" data-testid="ocr-reread-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col gap-3 overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-md sm:rounded-xl">
        <h2 className="text-zk-md font-semibold">導入 OCR 重讀建議</h2>
        <p className="text-zk-sm text-zk-muted">上載本機重讀腳本出嘅 proposals.json。先預覽（唔會寫入），確認計數啱先套用；每題都經同單題答題一樣嘅預覽＝寫入路徑，只會「確認」包內嘅值，唔會覆蓋現有唔同嘅資料。</p>
        <Banner kind="error" message={error} />
        <label className="block text-zk-base">
          <span className="mb-1 block text-zk-sm text-zk-muted">proposals.json</span>
          <input type="file" accept="application/json,.json" aria-label="上載建議檔" data-testid="ocr-reread-file" disabled={busy || !!done} onChange={(e) => void onFile(e.target.files?.[0] ?? null)} className="block w-full text-zk-sm" />
        </label>
        {fileName && !shown && !error && <div className="text-zk-sm text-zk-muted">{busy ? "預覽緊…" : fileName}</div>}
        {shown && (
          <div className="space-y-1 rounded-lg border border-zk-border p-3 text-zk-base" data-testid="ocr-reread-counts">
            <div className="font-semibold">{done ? "已套用" : "預覽（未寫入）"}</div>
            <div>建議共 {shown.proposals_total} 條 · 配對到 {shown.matched_questions} 題</div>
            <div data-testid="ocr-reread-applied">{done ? "已答" : "可自動答"} {shown.applied} 題</div>
            {(shown.applied_partial ?? 0) > 0 && (
              <div className="text-zk-sm text-zk-muted" data-testid="ocr-reread-partial">
                其中 {shown.applied_partial} 題只答有建議嘅欄，另開 {shown.follow_up_created ?? 0} 條跟進題畀剩餘欄
              </div>
            )}
            {SKIP_LABEL.filter(([k]) => (shown[k] as number) > 0).map(([k, label]) => (
              <div key={k} className="text-zk-sm text-zk-muted">
                {label}：{shown[k] as number} 條
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close} data-testid="ocr-reread-close">
            {done ? "完成" : "取消"}
          </Button>
          {!done && (
            <Button variant="primary" disabled={busy || !dry || dry.applied === 0} onClick={() => void apply()} data-testid="ocr-reread-apply">
              確認套用 {dry ? dry.applied : 0} 題
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
