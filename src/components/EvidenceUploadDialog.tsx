"use client";
// TE-1：分診 session 卡「⋯」→「上載覆核裁圖」。上載本機 20-triage-evidence.ts 出嘅 zip →
// 先 dry run（淨計數，唔寫）→ 確認套用。回應只有計數（配對題數／張數／跳過原因），唔顯示任何檔名或欄位值。375px 單欄。
import { useRef, useState } from "react";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { apiUpload } from "@/lib/ui/api-client";

interface Counts {
  dry_run: boolean;
  items_total: number;
  matched_questions: number;
  accepted_images: number;
  skipped_invalid: number;
  skipped_invalid_image: number;
  skipped_identity_mismatch: number;
  skipped_no_question: number;
  skipped_not_needed: number;
  skipped_restricted: number;
  skipped_duplicate: number;
  skipped_over_limit: number;
}
const SKIP_LABEL: [keyof Counts, string][] = [
  ["skipped_no_question", "冇對應未答題"],
  ["skipped_not_needed", "題目唔需要呢個欄"],
  ["skipped_identity_mismatch", "身份對唔上"],
  ["skipped_duplicate", "重覆（已上載過）"],
  ["skipped_over_limit", "超出張數上限"],
  ["skipped_invalid", "來源／優先次序唔合規格"],
  ["skipped_invalid_image", "圖片格式唔合規格"],
  ["skipped_restricted", "冇權限"],
];
const MAX_ZIP = 8 * 1024 * 1024;

export function EvidenceUploadDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const { close } = useHistoryOverlay(true, onClose, `evidence-upload-${sessionId}`);
  const file = useRef<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dry, setDry] = useState<Counts | null>(null);
  const [done, setDone] = useState<Counts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = (dryRun: boolean) => {
    const fd = new FormData();
    fd.append("file", file.current!);
    return apiUpload<Counts>(`/api/triage/sessions/${sessionId}/evidence-images${dryRun ? "?dry_run=1" : ""}`, fd);
  };

  async function onFile(f: File | null) {
    setDry(null);
    setDone(null);
    setError(null);
    file.current = null;
    setFileName(f ? f.name : null);
    if (!f) return;
    if (f.size > MAX_ZIP) {
      setError("zip 檔案太大（上限 8 MB）");
      return;
    }
    file.current = f;
    setBusy(true);
    const res = await post(true);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDry(res.data);
  }

  async function apply() {
    if (!file.current) return;
    setBusy(true);
    setError(null);
    const res = await post(false);
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
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="上載覆核裁圖" data-testid="evidence-upload-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col gap-3 overflow-y-auto rounded-t-xl bg-white p-4 shadow-xl sm:max-w-md sm:rounded-xl">
        <h2 className="text-zk-md font-semibold">上載覆核裁圖</h2>
        <p className="text-zk-sm text-zk-muted">上載本機腳本出嘅 zip（只有證件／入職表嘅欄位裁圖）。先預覽（唔會寫入），確認配對題數啱先套用。圖會加密儲存，答完題即刪；跳過嘅題最多留 30 日。</p>
        <Banner kind="error" message={error} />
        <label className="block text-zk-base">
          <span className="mb-1 block text-zk-sm text-zk-muted">裁圖 zip（≤ 8 MB）</span>
          <input type="file" accept="application/zip,.zip" aria-label="上載裁圖 zip" data-testid="evidence-upload-file" disabled={busy || !!done} onChange={(e) => void onFile(e.target.files?.[0] ?? null)} className="block w-full text-zk-sm" />
        </label>
        {fileName && !shown && !error && <div className="text-zk-sm text-zk-muted">{busy ? "預覽緊…" : "已揀檔案"}</div>}
        {shown && (
          <div className="space-y-1 rounded-lg border border-zk-border p-3 text-zk-base" data-testid="evidence-upload-counts">
            <div className="font-semibold">{done ? "已套用" : "預覽（未寫入）"}</div>
            <div>檔內共 {shown.items_total} 張 · 配對到 {shown.matched_questions} 題</div>
            <div data-testid="evidence-upload-accepted">
              {done ? "已儲存" : "可儲存"} {shown.accepted_images} 張
            </div>
            {SKIP_LABEL.filter(([k]) => (shown[k] as number) > 0).map(([k, label]) => (
              <div key={k} className="text-zk-sm text-zk-muted">
                {label}：{shown[k] as number} 張
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close} data-testid="evidence-upload-close">
            {done ? "完成" : "取消"}
          </Button>
          {!done && (
            <Button variant="primary" disabled={busy || !dry || dry.accepted_images === 0} onClick={() => void apply()} data-testid="evidence-upload-apply">
              確認儲存 {dry ? dry.accepted_images : 0} 張
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
