// WP-UPLOAD-VOID（老闆 2026-09-25 追加要求）：更表上載頁「多檔拖放／
// 多選上載」——呢個檔案淨係放**純函數**（分類結果／並發隊列排程），
// 冇 DOM／React 依賴，方便 vitest 直接測（唔使起瀏覽器）。實際上載
// UI 邏輯（state／FormData／apiUpload）留喺 page.tsx，呢度淨係俾佢
// 攞嚟用。
//
// 背景：老闆要求上載區改做 `<input multiple>`＋拖放多檔，月份揀一個
// 套用晒成批，逐個檔獨立叫現有 `POST /api/roster-uploads`（後端唔
// 改），順序處理但最多同時 2 個（避免同盤同月 advisory lock 排隊、亦
// 避免一次過㩒十幾個檔轟炸後端）；每個檔獨立顯示進度／結果——成功／
// 解析失敗／盤對唔到／400，一個檔失敗唔影響其餘。

/** `POST /api/roster-uploads` response body（`data` 嗰截）——淨係列出
 * 分類要用到嘅欄，唔係完整 DTO。 */
export interface RosterUploadPostData {
  upload: { id: string; site_id: string | null; version: number; status: string };
  superseded_count: number;
  parse_ok: boolean;
  parse_error: string | null;
  duplicate_of_version: number | null;
}

/** `apiUpload()`（src/lib/ui/api-client.ts）嘅 `ApiResult<T>`——呢度
 * 唔直接 import 嗰個 type（page.tsx 用緊嘅版本），淨係複製個 shape，
 * 等呢個檔案可以保持零 DOM/React 依賴、獨立畀 vitest（node 環境）測。 */
export type RosterUploadApiResult = { ok: true; status: number; data: RosterUploadPostData } | { ok: false; status: number; error: string; message: string };

type UploadOutcomeKind = "success" | "parse_failed" | "unresolved" | "error";

export interface UploadOutcome {
  kind: UploadOutcomeKind;
  /** 一句話總結，直接喺隊列結果行顯示。 */
  summary: string;
  uploadId: string | null;
}

/** 逐個檔上載完之後嘅結果歸類——四類：
 *   - `error`：response 唔 ok（400/403/409…）
 *   - `parse_failed`：201 但 `parse_ok=false`（存底咗但解析唔到）
 *   - `unresolved`：201 解析成功但 `site_id=null`（盤名對唔到，要人手
 *     指定盤——呢類前端要出「指定盤」下拉）
 *   - `success`：201 + 解析成功 + 盤已解到
 * 純函數，冇副作用，方便逐個 case 單元測試。 */
export function classifyUploadResult(res: RosterUploadApiResult): UploadOutcome {
  if (!res.ok) {
    return { kind: "error", summary: res.message || "上載失敗", uploadId: null };
  }
  const { data } = res;
  if (!data.parse_ok) {
    return { kind: "parse_failed", summary: `已存底但解析失敗：${data.parse_error ?? "未知原因"}`, uploadId: data.upload.id };
  }
  if (!data.upload.site_id) {
    return { kind: "unresolved", summary: "盤名未配對，要指定盤先可以對數", uploadId: data.upload.id };
  }
  const dupNote = data.duplicate_of_version ? `；同第 ${data.duplicate_of_version} 版一模一樣（SHA-256 相同）` : "";
  const supersedeNote = data.superseded_count ? `，取代咗 ${data.superseded_count} 個舊版` : "";
  return { kind: "success", summary: `已上載 v${data.upload.version}${supersedeNote}${dupNote}`, uploadId: data.upload.id };
}

export interface UploadQueueSummary {
  total: number;
  success: number;
  parseFailed: number;
  unresolved: number;
  error: number;
  /** 仲有幾多個 pending/uploading（未跑完）。 */
  inProgress: number;
}

export function summarizeOutcomes<T extends { status: "pending" | "uploading" | "done" | "cancelled"; outcome?: UploadOutcome }>(items: readonly T[]): UploadQueueSummary {
  let success = 0;
  let parseFailed = 0;
  let unresolved = 0;
  let error = 0;
  let inProgress = 0;
  for (const item of items) {
    if (item.status === "pending" || item.status === "uploading") {
      inProgress += 1;
      continue;
    }
    if (item.status === "cancelled") continue;
    switch (item.outcome?.kind) {
      case "success":
        success += 1;
        break;
      case "parse_failed":
        parseFailed += 1;
        break;
      case "unresolved":
        unresolved += 1;
        break;
      case "error":
        error += 1;
        break;
    }
  }
  return { total: items.length, success, parseFailed, unresolved, error, inProgress };
}

/** 並發上限嘅隊列排程——每次揾第一個 `pending` 嘅項處理，處理緊嗰陣
 * worker 唔會揀第二次（`onStart` callback 負責即刻將個 item 由
 * pending 轉走，等下一個 worker 唔會撞同一項）。唔負責 DOM／React
 * state，淨係負責「邊個 item 幾時輪到邊個 worker 做」呢個排程邏輯，
 * 等 `pickNext`／並發控制可以獨立測試，唔使起成個 React 組件。 */
export async function runQueueWithConcurrency<T>(params: {
  items: readonly T[];
  concurrency: number;
  /** 揾下一個要處理嘅 item——冇就 null（隊列見底或者剩低嘅都俾人
   * 取消咗）。呢個 function 要喺揀中之後**同步**標記個 item（例如轉
   * 做 "uploading"），唔可以淨係揀完就算，否則兩個 worker 會撞中
   * 同一個 pending item。 */
  pickNext: () => T | null;
  worker: (item: T) => Promise<void>;
}): Promise<void> {
  const { concurrency, pickNext, worker } = params;
  async function runOne(): Promise<void> {
    for (;;) {
      const item = pickNext();
      if (!item) return;
      await worker(item);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, params.items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
}
