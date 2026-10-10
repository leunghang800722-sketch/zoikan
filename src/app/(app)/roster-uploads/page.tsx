"use client";
// WP-ROSTER-UPLOAD Phase A（§15.3）：更表上載頁（排更區）——老闆／主管／
// 會計每月逐盤上載更表檔案（xlsx），即時解析＋對照（盤／更別／安員／
// 雞頭），**唔寫入 shift_records**（對數＋寫入係 Phase B）。雞頭／安員
// 呢個 module 硬性 deny，連呢頁都入唔到（API 一律 403，見 matrix.ts）。
//
// WP-UPLOAD-VOID（老闆 2026-09-25 要求）：
//   1. 作廢——正式站揀錯月份上載咗 8 月更表，之前冇任何刪除／撤銷。逐個
//      已上載嘅盤／詳情頁加「作廢」掣（`ConfirmVoidButton`，強制填原因），
//      作廢後列表刷新（voided 唔再顯示做「已上載」）；「顯示已作廢」開關
//      額外列返灰色行（版本、原因、邊個、幾時）追溯用。
//   2. 多檔拖放／多選上載——上載區由單檔改做 `<input multiple>`＋拖放多
//      檔，月份一個套用晒成批，逐個檔獨立叫現有 `POST /api/roster-uploads`
//      （後端唔改），順序處理、最多同時 2 個（`runQueueWithConcurrency()`，
//      `src/lib/roster-upload/upload-queue.ts`——純函數，避免同盤同月
//      advisory lock 排隊）；每個檔獨立顯示進度／結果（成功／解析失敗／
//      盤對唔到／400），一個檔失敗唔影響其餘，全部跑完顯示總結。
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiUpload, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Field, selectCls } from "@/components/ui/Field";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate, fmtDateTime, currentMonthStr } from "@/lib/ui/format";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import { classifyUploadResult, runQueueWithConcurrency, summarizeOutcomes, type RosterUploadPostData, type UploadOutcome } from "@/lib/roster-upload/upload-queue";

interface SiteOption {
  id: string;
  canonical_name: string;
}

interface RosterUploadDTO {
  id: string;
  month: string;
  site_id: string | null;
  site_name_raw: string;
  uploader_user_id: string;
  uploaded_at: string;
  file_name: string;
  file_sha256: string;
  file_size: number;
  version: number;
  status: "uploaded" | "parsed" | "parse_failed" | "superseded" | "confirmed" | "voided";
  parse_summary: {
    total_cell_count: number;
    shift_count: number;
    unmatched_guard_count: number;
    ambiguous_guard_count: number;
    unmatched_shift_type_count: number;
    ambiguous_shift_type_count: number;
    unmatched_broker_count: number;
    out_of_month_count: number;
    // Phase B-0：合併格展開格數／子盤對唔到格數／舊工號兩類格數。
    merged_expanded_count: number;
    unmatched_sub_site_count: number;
    stale_staff_no_count: number;
    staff_no_mismatch_count: number;
    // 補丁（§17.7 未修第一項）：更別配對用 rank_raw 第三層收窄配到嘅格數。
    rank_narrowed_count: number;
    date_range: { min: string; max: string } | null;
    warnings: string[];
  } | null;
  parse_error: string | null;
  layout_key: string | null;
  // WP-UPLOAD-VOID：作廢先有值。
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

interface SiteStatusEntry {
  site_id: string | null;
  site_name: string;
  upload_status: string;
  upload: RosterUploadDTO | null;
}
interface ListResponse {
  month: string;
  sites: SiteStatusEntry[];
  unresolved_uploads: SiteStatusEntry[];
  voided_uploads: SiteStatusEntry[];
}

interface RosterUploadRowDTO {
  id: string;
  upload_id: string;
  row_index: number;
  sub_site_name: string | null;
  work_date: string;
  raw_code: string;
  code_kind: "shift" | "leave" | "ot" | "marker" | "unknown";
  shift_type_id: string | null;
  // Phase B-0 第 3 項：一檔多子盤（城巴車廠／CP5）解析後嘅實際盤——冇
  // 子盤嘅上載一律等於呢個上載自己嘅 site_id。
  resolved_site_id: string | null;
  staff_no_raw?: string;
  name_raw?: string;
  tel_raw?: string;
  rank_raw: string | null;
  time_raw: string | null;
  broker_code_raw: string | null;
  guard_id: string | null;
  guard_match: "by_staff_no" | "by_name_tel" | "by_name" | "unmatched" | "ambiguous";
  match_basis?: "staff_no" | "tel" | "name_tel" | "name_only" | "alias" | "override" | null;
  settlement_broker_id: string | null;
  hours: number | null;
  warnings: string[] | null;
}
interface DetailResponse {
  upload: RosterUploadDTO;
  rows: ApiListResult<RosterUploadRowDTO>;
  // WP-STAFF-IMPORT B2：淨靠姓名配對格數＋警告文案。
  name_only_count?: number;
  name_only_warning?: string | null;
}

interface VoidResponse {
  upload: RosterUploadDTO;
  revived_upload_id: string | null;
  revived_version: number | null;
}

// WP-LTSHIFT §19 交付 C：「重新對數全月」。
interface ReconcileAllPerUploadDTO {
  upload_id: string;
  site_label: string;
  before: { roster_only: number; settlement_diff: number; unresolved: number };
  settlement_scanned: number;
  settlement_changed: number;
  applied: number;
  skipped_apply_reason: string | null;
  errors: string[];
}
// 2026-09-27 修正：`ok()` 會 `camelToSnakeDeep()` 成個 response（含 result_json），
// 之前 DTO 用 camelCase 讀 `perUpload`／`uploadCount` → undefined.filter → 成頁
// crash（正式站實測「Application error」）。全部改 snake_case。
interface ReconcileAllRunDTO {
  id: string;
  month: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  apply_allowed: boolean;
  result: {
    upload_count: number;
    /** 驗收（Opus 5.5）：舊 run 冇呢欄。 */
    warnings?: string[];
    /** 驗收修正：開頭自動 reprice 結果；舊 run 冇呢欄。 */
    repriced?: { scanned: number; changed: number };
    per_upload?: ReconcileAllPerUploadDTO[];
    totals: { roster_only_before: number; settlement_diff_before: number; unresolved_before: number; settlement_changed: number; applied: number; uploads_with_errors: number };
  } | null;
  error_message: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  not_uploaded: "未上載",
  uploaded: "已上載",
  parsed: "已上載",
  parse_failed: "解析失敗",
  superseded: "已被取代",
  confirmed: "已對數確認",
  voided: "已作廢",
};
function statusPillVariant(status: string): "neutral" | "success" | "danger" | "warning" {
  if (status === "not_uploaded" || status === "voided") return "neutral";
  if (status === "parse_failed") return "danger";
  if (status === "parsed" || status === "confirmed") return "success";
  return "warning";
}

const GUARD_MATCH_LABEL: Record<string, string> = {
  by_staff_no: "工號配對",
  by_name_tel: "姓名+電話配對",
  by_name: "姓名配對",
  unmatched: "未配對",
  ambiguous: "多個候選",
};

// Phase B-0 第 4 項：呢兩類淨係 warnings 文字（唔改 guard_match enum），
// 對應 API `?warning_flag=`（唔係 `?guard_match=`）。
const WARNING_FLAG_VALUES = new Set(["staff_no_mismatch", "stale_staff_no"]);
// WP-STAFF-IMPORT B2：`?match_basis=name_only`。
const MATCH_BASIS_FILTER_VALUES = new Set(["name_only"]);

// WP-UPLOAD-VOID：多檔拖放隊列——逐個檔獨立處理／顯示，`month`／
// `siteIdHint` 喺 enqueue 嗰刻捕捉（避免用戶入面轉月份／盤影響緊處理
// 緊嘅檔）。
interface QueueItem {
  localId: string;
  file: File;
  month: string;
  siteIdHint?: string;
  // 揀／拖淨係一個檔嗰陣先開（同單檔上載舊行為一致——上載完即刻喺
  // 詳情區見到結果，唔使額外撳「睇詳情」）；一次過幾個檔就唔自動開，
  // 由用戶自己揀邊個睇。
  autoOpenDetail?: boolean;
  status: "pending" | "uploading" | "done" | "cancelled";
  outcome?: UploadOutcome;
}
const UPLOAD_CONCURRENCY = 2;

export default function RosterUploadsPage() {
  const [month, setMonth] = useState(currentMonthStr());
  // WP-RECONCILE-UI（§33.3 D）：deep link `?month=YYYY-MM&focus=<uploadId>`——只做預選月份＋捲到／高亮該上載，
  // 唔觸發任何寫入。URL 解析完（urlReady）先載列表，避免先載當月再載目標月份互相覆蓋。
  const [urlReady, setUrlReady] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusDoneRef = useRef<string | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // WP-UPLOAD-VOID：「顯示已作廢」開關——預設關，避免會計誤將已作廢
  // 版本當做仲生效；開咗先叫 API 帶 `include_voided=1`。
  const [includeVoided, setIncludeVoided] = useState(false);

  const [uploadSiteId, setUploadSiteId] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WP-UPLOAD-VOID：多檔上載隊列。`queueRef` 係並發排程用嘅同步真相
  // （`pickNextQueueItem()` 揀中即刻同步標記 uploading，先唔會兩個
  // worker 撞中同一項），`queue` state 淨係俾 UI 重新 render。
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  // Opus 5.5 驗收：跨批次嘅全局並發上限——之前每拖一批就另開最多 2 個
  // worker，第一批未跑完再拖第二批會同時有 3-4 個 request 在途。而家
  // 記住仲生存緊嘅 worker 數，新一批淨係補返「空位」；已經生存緊嘅
  // worker 會喺做完手頭嗰個之後自己去全局隊列揀新入隊嘅 pending 項。
  const activeWorkersRef = useRef(0);

  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 驗收 2026-09-23：原本淨係得「只顯示未配對」checkbox——「多個候選」（同名
  // 多人）同「淨係姓名配對」一樣要人手覆核，改做下拉。Phase B-0 第 4 項：
  // 加多兩類（工號唔一致／已取消舊號配對）——呢兩類唔係 `guard_match`
  // enum 值，係喺 warnings 文字入面（見 match.ts GuardMatchResult 註解），
  // 對應 API 嘅 `?warning_flag=` 參數（`loadDetail()` 自己分流）。
  const [matchFilter, setMatchFilter] = useState<"" | "unmatched" | "ambiguous" | "by_name" | "staff_no_mismatch" | "stale_staff_no" | "name_only">("");
  const [patchingSiteFor, setPatchingSiteFor] = useState<string | null>(null);

  // WP-LTSHIFT §19 交付 C：「重新對數全月」——一鍵重算結算單位＋對數＋
  // 全部以更表為準套用（見 src/lib/roster-upload/reconcile-all.ts）。
  const [reconcileAllRunning, setReconcileAllRunning] = useState(false);
  const [reconcileAllResult, setReconcileAllResult] = useState<ReconcileAllRunDTO | null>(null);
  const reconcileAllPollRef = useRef<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ month });
    if (includeVoided) qs.set("include_voided", "1");
    const res = await apiGet<ListResponse>(`/api/roster-uploads?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setList(res.data);
    setLoading(false);
  }

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const m = sp.get("month");
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) setMonth(m);
    const f = sp.get("focus");
    if (f) setFocusId(f);
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, includeVoided, urlReady]);

  // 列表載入後：捲到目標上載（桌面表／手機卡二揀一，取當前可見嗰個）、聚焦「指定盤」下拉。
  useEffect(() => {
    if (!focusId || !list || focusDoneRef.current === focusId) return;
    const els = [...document.querySelectorAll<HTMLElement>(`[data-upload-id="${CSS.escape(focusId)}"]`)];
    const el = els.find((e) => e.getClientRects().length > 0);
    if (!el) return;
    focusDoneRef.current = focusId;
    el.scrollIntoView({ block: "center" });
    el.querySelector<HTMLElement>("select")?.focus({ preventScroll: true });
  }, [focusId, list]);

  async function pollReconcileAllUntilDone(runId: string, forMonth: string): Promise<ReconcileAllRunDTO | null> {
    for (let i = 0; i < 1200; i++) {
      const res = await apiGet<{ runs: ReconcileAllRunDTO[] }>(`/api/roster-uploads/reconcile-all?month=${forMonth}-01`);
      if (res.ok) {
        const run = res.data.runs.find((r) => r.id === runId);
        if (run && (run.status === "done" || run.status === "failed")) return run;
        if (run && run.status === "running" && run.apply_allowed) return run; // 卡死（>15 分鐘）
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  async function onReconcileAll() {
    if (reconcileAllPollRef.current) return;
    setError(null);
    setNotice(null);
    setReconcileAllResult(null);
    setReconcileAllRunning(true);
    const res = await apiPost<{ run_id: string; status: string }>("/api/roster-uploads/reconcile-all", { month });
    if (!res.ok) {
      setReconcileAllRunning(false);
      setError(res.message);
      return;
    }
    reconcileAllPollRef.current = res.data.run_id;
    const finalRun = await pollReconcileAllUntilDone(res.data.run_id, month);
    reconcileAllPollRef.current = null;
    setReconcileAllRunning(false);
    if (!finalRun) {
      setError("重新對數全月仲未完成（等咗 40 分鐘）——請稍後撳「重新整理」");
      return;
    }
    if (finalRun.status === "running") {
      setError("執行超過 15 分鐘都未完成（可能伺服器中途重啟）——可以再撳一次「重新對數全月」（安全，冪等）");
      return;
    }
    if (finalRun.status === "failed") {
      setError(`重新對數全月失敗：${finalRun.error_message ?? "未知原因"}`);
      return;
    }
    setReconcileAllResult(finalRun);
    setNotice(
      finalRun.result
        ? `重新對數全月完成：${finalRun.result.upload_count} 個上載、套用 ${finalRun.result.totals.applied} 項、改咗 ${finalRun.result.totals.settlement_changed} 格結算單位`
        : "重新對數全月完成",
    );
    await loadList();
  }

  useEffect(() => {
    apiGet<ApiListResult<SiteOption>>("/api/sites?take=500").then((res) => {
      if (res.ok) setSites(res.data.rows);
    });
  }, []);

  // 驗收 2026-09-23：API 每頁上限 500 格，大盤（例如城巴車廠）一個月過千格——
  // 之前淨係攞第一頁，後面嘅格靜靜睇唔到。而家顯示「已載入 N／共 T」＋「載入更多」。
  async function loadDetail(uploadId: string, filter?: string, append = false) {
    setDetailLoading(true);
    const skip = append && detail ? detail.rows.rows.length : 0;
    const qs = new URLSearchParams({ take: "500", skip: String(skip) });
    if (filter) {
      if (MATCH_BASIS_FILTER_VALUES.has(filter)) qs.set("match_basis", filter);
      else if (WARNING_FLAG_VALUES.has(filter)) qs.set("warning_flag", filter);
      else qs.set("guard_match", filter);
    }
    const res = await apiGet<DetailResponse>(`/api/roster-uploads/${uploadId}?${qs.toString()}`);
    setDetailLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (append && detail) {
      setDetail({ ...res.data, rows: { ...res.data.rows, rows: [...detail.rows.rows, ...res.data.rows.rows] } });
    } else {
      setDetail(res.data);
    }
  }

  function openDetail(uploadId: string) {
    setSelectedUploadId(uploadId);
    setDetail(null);
    setMatchFilter("");
    loadDetail(uploadId);
  }

  useEffect(() => {
    if (selectedUploadId) loadDetail(selectedUploadId, matchFilter || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchFilter]);

  // ---------------------------------------------------------------------
  // WP-UPLOAD-VOID：多檔上載隊列——`applyQueue()` 同時更新 state＋
  // `queueRef`（同步真相，俾 `pickNextQueueItem()` 用），`pickNextQueueItem()`
  // 冇 await，喺 JS 單線程之下同步揀+標記係 atomic，唔會兩個 worker
  // 撞中同一個 pending item。
  // ---------------------------------------------------------------------
  function applyQueue(next: QueueItem[]) {
    queueRef.current = next;
    setQueue(next);
  }

  function pickNextQueueItem(): QueueItem | null {
    const current = queueRef.current;
    const idx = current.findIndex((q) => q.status === "pending");
    if (idx === -1) return null;
    const item: QueueItem = { ...current[idx]!, status: "uploading" };
    const next = current.slice();
    next[idx] = item;
    applyQueue(next);
    return item;
  }

  function updateQueueItem(localId: string, patch: Partial<QueueItem>) {
    applyQueue(queueRef.current.map((q) => (q.localId === localId ? { ...q, ...patch } : q)));
  }

  function cancelQueueItem(localId: string) {
    applyQueue(queueRef.current.map((q) => (q.localId === localId && q.status === "pending" ? { ...q, status: "cancelled" as const } : q)));
  }

  async function uploadQueueItem(item: QueueItem) {
    const form = new FormData();
    form.set("file", item.file);
    form.set("month", item.month);
    if (item.siteIdHint) form.set("site_id", item.siteIdHint);
    const res = await apiUpload<RosterUploadPostData>("/api/roster-uploads", form);
    const outcome = classifyUploadResult(res);
    updateQueueItem(item.localId, { status: "done", outcome });
    await loadList();
    // 單檔上載（拖／揀淨係一個檔）：沿用舊行為，上載完即刻喺詳情區見到
    // 結果，唔使額外撳「睇詳情」。呢個要喺 `loadList()` 之後先做，等
    // 詳情頁打開嗰陣主列表已經係最新（例如「盤對唔到」嗰行已經出現）。
    if (item.autoOpenDetail && outcome.uploadId) openDetail(outcome.uploadId);
  }

  // 月份揀一個套用晒成批（`month` 喺 enqueue 嗰刻捕捉，之後轉月份唔會
  // 影響已經入隊嘅檔）；`siteIdHint`（「盤（可選）」下拉）淨係喺一次過
  // 揀／拖淨係一個檔嗰陣先套用——一次過幾個檔通常係唔同盤，唔應該逼佢
  // 哋撞同一個盤。
  function enqueueFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (!arr.length) return;
    const isSingle = arr.length === 1;
    const singleHint = isSingle && uploadSiteId ? uploadSiteId : undefined;
    const newItems: QueueItem[] = arr.map((file, i) => ({
      localId: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      month,
      siteIdHint: singleHint,
      autoOpenDetail: isSingle,
      status: "pending",
    }));
    applyQueue([...queueRef.current, ...newItems]);
    const slots = Math.min(UPLOAD_CONCURRENCY - activeWorkersRef.current, newItems.length);
    if (slots <= 0) return; // 現有 worker 做完手頭嗰個會自己揀新入隊嘅項
    activeWorkersRef.current += slots;
    void runQueueWithConcurrency({ items: newItems, concurrency: slots, pickNext: pickNextQueueItem, worker: uploadQueueItem }).finally(() => {
      activeWorkersRef.current -= slots;
    });
  }

  function onFilesChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length) enqueueFiles(files);
    e.target.value = "";
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length) enqueueFiles(files);
  }

  // WP-UPLOAD-VOID：隊列入面「盤對唔到」嗰行揀咗盤之後，直接喺隊列度
  // 反映做成功（唔使用戶再去主列表搵返個上載先可以指定盤）。
  async function assignSiteForQueueItem(item: QueueItem, siteId: string) {
    if (!item.outcome?.uploadId) return;
    updateQueueItem(item.localId, { status: "uploading" });
    const res = await apiPatch(`/api/roster-uploads/${item.outcome.uploadId}`, { site_id: siteId });
    if (!res.ok) {
      updateQueueItem(item.localId, { status: "done", outcome: { kind: "error", summary: res.message, uploadId: item.outcome.uploadId } });
      return;
    }
    updateQueueItem(item.localId, { status: "done", outcome: { kind: "success", summary: "已指定盤，重新配對完成", uploadId: item.outcome.uploadId } });
    await loadList();
  }

  const queueSummary = summarizeOutcomes(queue);
  const queueDone = queue.length > 0 && queueSummary.inProgress === 0;

  async function patchSiteId(uploadId: string, siteId: string) {
    setPatchingSiteFor(uploadId);
    const res = await apiPatch(`/api/roster-uploads/${uploadId}`, { site_id: siteId || null });
    setPatchingSiteFor(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(siteId ? "已指定盤，重新配對完成" : "已清返盤");
    await loadList();
    if (selectedUploadId === uploadId) loadDetail(uploadId, matchFilter || undefined);
  }

  async function doReparse(uploadId: string) {
    const res = await apiPost(`/api/roster-uploads/${uploadId}/reparse`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已重新解析");
    await loadList();
    if (selectedUploadId === uploadId) loadDetail(uploadId, matchFilter || undefined);
  }

  // WP-UPLOAD-VOID：作廢——`ConfirmVoidButton` 強制填原因先叫呢個 function。
  async function onVoidUpload(uploadId: string, reason: string) {
    setError(null);
    const res = await apiPost<VoidResponse>(`/api/roster-uploads/${uploadId}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const revivedNote = res.data.revived_version ? `；v${res.data.revived_version} 已回復做現行版本` : "";
    setNotice(`已作廢${revivedNote}`);
    if (selectedUploadId === uploadId) setSelectedUploadId(null);
    await loadList();
  }

  const allEntries = list ? [...list.sites, ...list.unresolved_uploads] : [];
  const voidedEntries = list?.voided_uploads ?? [];
  const colCount = 7;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="排更"
        title="更表上載"
        subtitle="會計／主管／老闆每月逐盤上載更表檔案（xlsx）——呢個係計糧嘅唯一依據，系統自己報更淨係參考／輔助。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip label="月份" showCaret={false}>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <label className="flex items-center gap-1.5 text-[12.5px] text-zk-muted">
              <input type="checkbox" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} />
              顯示已作廢
            </label>
            <Button variant="secondary" onClick={onReconcileAll} disabled={reconcileAllRunning || !/^\d{4}-\d{2}$/.test(month)} data-testid="reconcile-all-button">
              {reconcileAllRunning ? "重新對數全月…" : "重新對數全月"}
            </Button>
          </div>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {reconcileAllRunning && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-[13px] text-zk-text" data-testid="reconcile-all-running">
          重新對數全月執行緊…（重算長工結算單位＋對數＋全部以更表為準套用，成月幾十個上載可能要幾分鐘）。可以留喺呢頁等，或者離開再返嚟——歷史會保留。
        </div>
      )}

      {reconcileAllResult?.result && (
        <div className="rounded-lg border border-zk-border bg-white p-4 text-[12.5px]" data-testid="reconcile-all-result">
          <div className="mb-2 text-[14px] font-semibold text-zk-text">重新對數全月結果（{reconcileAllResult.month.slice(0, 7)}）</div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-zk-muted">
            <span>{reconcileAllResult.result.upload_count} 個上載</span>
            {reconcileAllResult.result.repriced && (
              <span data-testid="reconcile-all-repriced">
                補價 {reconcileAllResult.result.repriced.changed} 格（掃 {reconcileAllResult.result.repriced.scanned} 格）
              </span>
            )}
            <span>套用 {reconcileAllResult.result.totals.applied} 項（roster_only {reconcileAllResult.result.totals.roster_only_before}、settlement_diff {reconcileAllResult.result.totals.settlement_diff_before}）</span>
            <span>改咗 {reconcileAllResult.result.totals.settlement_changed} 格結算單位</span>
            <span>未配對留低 {reconcileAllResult.result.totals.unresolved_before} 格</span>
            {reconcileAllResult.result.totals.uploads_with_errors > 0 && <span className="text-red-700">{reconcileAllResult.result.totals.uploads_with_errors} 個上載有錯誤</span>}
          </div>
          {(reconcileAllResult.result.warnings ?? []).map((w) => (
            <div key={w} className="mb-2 rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-amber-800" data-testid="reconcile-all-warning">
              {w}
            </div>
          ))}
          <ul className="max-h-64 divide-y divide-zk-border overflow-y-auto rounded border border-zk-border">
            {(reconcileAllResult.result.per_upload ?? [])
              .filter((u) => u.applied > 0 || u.settlement_changed > 0 || u.before.unresolved > 0 || (u.errors ?? []).length > 0)
              .map((u) => (
                <li key={u.upload_id} className="px-2.5 py-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-medium text-zk-text">{u.site_label}</span>
                    <span className="shrink-0 tabular-nums text-zk-muted">
                      套用 {u.applied}・改結算 {u.settlement_changed}・未配對 {u.before.unresolved}
                    </span>
                  </div>
                  {u.skipped_apply_reason && <div className="mt-0.5 text-amber-700">{u.skipped_apply_reason}</div>}
                  {(u.errors ?? []).length > 0 && <div className="mt-0.5 break-words text-red-700">{u.errors.slice(0, 3).join("；")}</div>}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* 上載區：拖放或選檔——WP-UPLOAD-VOID：而家可以一次過揀／拖多個檔。 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="盤（一次過上載一個檔先會套用——多檔通常唔同盤，留返自動配對或者跟住喺列表指定）">
            <select className={selectCls} value={uploadSiteId} onChange={(e) => setUploadSiteId(e.target.value)}>
              <option value="">（由檔案盤名自動配對）</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div
          data-testid="roster-upload-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragOver ? "border-[#2563eb] bg-blue-50" : "border-zk-border bg-zk-surface"
          }`}
        >
          <div className="text-[13.5px] font-medium text-zk-text">{queueSummary.inProgress > 0 ? "上載緊…" : "拖放更表 xlsx 到呢度（可以一次過拖多個），或者撳呢度揀檔"}</div>
          <div className="text-[12px] text-zk-muted">可以一次過揀多個 xlsx 檔，單一檔最大 20MB</div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            multiple
            className="hidden"
            onChange={onFilesChosen}
            data-testid="roster-upload-file-input"
          />
        </div>

        {/* WP-UPLOAD-VOID：多檔上載隊列——逐檔獨立進度／結果，一個檔失敗唔影響其餘。 */}
        {queue.length > 0 && (
          <div className="mt-3 space-y-1.5" data-testid="roster-upload-queue">
            {queue.map((item) => (
              <div key={item.localId} className="flex flex-wrap items-center gap-2 rounded-md border border-zk-border px-2.5 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-medium text-zk-text">{item.file.name}</span>
                {item.status === "pending" && (
                  <>
                    <Pill variant="neutral">等緊</Pill>
                    <button type="button" onClick={() => cancelQueueItem(item.localId)} className="rounded-[5px] border border-zk-border px-2 py-[2px] text-xs text-[#334155] hover:bg-zk-header">
                      取消
                    </button>
                  </>
                )}
                {item.status === "uploading" && <Pill variant="warning">上載緊…</Pill>}
                {item.status === "cancelled" && <Pill variant="neutral">已取消</Pill>}
                {item.status === "done" && item.outcome && (
                  <>
                    <Pill
                      variant={item.outcome.kind === "success" ? "success" : item.outcome.kind === "unresolved" ? "warning" : "danger"}
                    >
                      {item.outcome.kind === "success" ? "成功" : item.outcome.kind === "parse_failed" ? "解析失敗" : item.outcome.kind === "unresolved" ? "盤對唔到" : "失敗"}
                    </Pill>
                    <span className="text-zk-muted">{item.outcome.summary}</span>
                    {item.outcome.kind === "unresolved" && (
                      <select
                        className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                        value=""
                        aria-label="指定盤"
                        onChange={(e) => e.target.value && assignSiteForQueueItem(item, e.target.value)}
                      >
                        <option value="">指定盤…</option>
                        {sites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.canonical_name}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                )}
              </div>
            ))}
            {queueDone && (
              <div className="text-[12.5px] text-zk-muted" data-testid="roster-upload-queue-summary">
                總結：成功 {queueSummary.success}／失敗 {queueSummary.error + queueSummary.parseFailed}／要指定盤 {queueSummary.unresolved}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 逐盤狀態表 */}
      {!loading && allEntries.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title={`${month} 未有任何盤`} description="先去「盤」頁加盤。" />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.thNum}>版本</th>
                  <th className={tableCls.thNum}>更數</th>
                  <th className={tableCls.thNum}>未配對</th>
                  <th className={tableCls.th}>操作</th>
                  <th className={tableCls.th}></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td className={tableCls.tdMuted} colSpan={colCount}>
                      載入緊…
                    </td>
                  </tr>
                )}
                {allEntries.map((entry) => {
                  const u = entry.upload;
                  const summary = u?.parse_summary;
                  return (
                    <tr
                      key={entry.site_id ?? `unresolved:${u?.id}`}
                      className={`${tableCls.rowHover} ${u && u.id === focusId ? "bg-yellow-50 outline outline-2 -outline-offset-2 outline-zk-primary" : ""}`}
                      data-upload-id={u?.id}
                      data-focused={u && u.id === focusId ? "1" : undefined}
                    >
                      <td className={`${tableCls.td} font-medium`}>
                        {entry.site_name}
                        {!entry.site_id && <span className="ml-1.5 text-[11px] text-orange-600">（盤名未配對）</span>}
                      </td>
                      <td className={tableCls.td}>
                        <Pill variant={statusPillVariant(entry.upload_status)}>{STATUS_LABEL[entry.upload_status] ?? entry.upload_status}</Pill>
                        {u?.status === "parse_failed" && u.parse_error && <div className="mt-1 text-[11px] text-red-600">{u.parse_error}</div>}
                      </td>
                      <td className={tableCls.tdNum}>{u ? `v${u.version}` : "—"}</td>
                      <td className={tableCls.tdNum}>{summary ? summary.shift_count : "—"}</td>
                      <td className={tableCls.tdNum}>
                        {summary && summary.unmatched_guard_count > 0 ? (
                          <span className="font-semibold text-orange-600">{summary.unmatched_guard_count}</span>
                        ) : summary ? (
                          "0"
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {u && (
                            <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                              睇詳情
                            </button>
                          )}
                          {/* B1-3：對數頁入口——冇解到盤（entry.site_id 未定）就冧唔到
                              盤，先要 PATCH 指定盤先可以對數。 */}
                          {u && entry.site_id && (u.status === "parsed" || u.status === "confirmed") && (
                            <Link
                              href={`/roster-uploads/${u.id}/reconcile`}
                              className="rounded-[5px] border border-zk-primary px-2.5 py-[3px] text-xs font-medium text-zk-primary hover:bg-blue-50"
                            >
                              對數
                            </Link>
                          )}
                          {u && !entry.site_id && (
                            <select
                              className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                              value=""
                              disabled={patchingSiteFor === u.id}
                              onChange={(e) => e.target.value && patchSiteId(u.id, e.target.value)}
                            >
                              <option value="">指定盤…</option>
                              {sites.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.canonical_name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                      <td className={tableCls.td}>{u && u.status !== "confirmed" && <ConfirmVoidButton label="作廢" confirmLabel="確認作廢" onConfirm={(reason) => onVoidUpload(u.id, reason)} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 手機（&lt;640）：卡列表 */}
          <div className="space-y-2 sm:hidden">
            {loading && <div className="rounded-lg border border-zk-border bg-white p-3 text-center text-[13px] text-zk-muted">載入緊…</div>}
            {allEntries.map((entry) => {
              const u = entry.upload;
              const summary = u?.parse_summary;
              return (
                <div
                  key={entry.site_id ?? `unresolved:${u?.id}`}
                  className={`rounded-lg border bg-white p-3 ${u && u.id === focusId ? "border-zk-primary bg-yellow-50 ring-2 ring-zk-primary" : "border-zk-border"}`}
                  data-upload-id={u?.id}
                  data-focused={u && u.id === focusId ? "1" : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{entry.site_name}</span>
                    <Pill variant={statusPillVariant(entry.upload_status)}>{STATUS_LABEL[entry.upload_status] ?? entry.upload_status}</Pill>
                  </div>
                  <div className="mt-1 text-[11.5px] text-zk-muted">
                    {u ? `v${u.version} · ${summary ? `${summary.shift_count} 更 · 未配對 ${summary.unmatched_guard_count}` : ""}` : "未上載"}
                    {!entry.site_id && <span className="ml-1.5 text-orange-600">（盤名未配對）</span>}
                  </div>
                  {u?.status === "parse_failed" && u.parse_error && <div className="mt-1 text-[11px] text-red-600">{u.parse_error}</div>}
                  {u && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                        睇詳情
                      </button>
                      {entry.site_id && (u.status === "parsed" || u.status === "confirmed") && (
                        <Link href={`/roster-uploads/${u.id}/reconcile`} className="rounded-[5px] border border-zk-primary px-2.5 py-[3px] text-xs font-medium text-zk-primary">
                          對數
                        </Link>
                      )}
                      {/* 驗收 2026-09-23：手機之前冇「指定盤」，盤名對唔到嘅上載喺手機處理唔到 */}
                      {!entry.site_id && (
                        <select
                          className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                          value=""
                          disabled={patchingSiteFor === u.id}
                          onChange={(e) => e.target.value && patchSiteId(u.id, e.target.value)}
                          aria-label="指定盤"
                        >
                          <option value="">指定盤…</option>
                          {sites.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.canonical_name}
                            </option>
                          ))}
                        </select>
                      )}
                      {u.status !== "confirmed" && <ConfirmVoidButton label="作廢" confirmLabel="確認作廢" onConfirm={(reason) => onVoidUpload(u.id, reason)} />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* WP-UPLOAD-VOID：「顯示已作廢」開關開咗先出現——灰色行追溯用
          （版本、原因、邊個、幾時）。呢啲上載已經係終態，冇任何操作掣，
          淨係得「睇詳情」（rows 仲留底，方便追查）。 */}
      {includeVoided && voidedEntries.length > 0 && (
        <div className="space-y-2">
          <div className="text-[12.5px] font-medium text-zk-muted">已作廢記錄</div>
          <div className={`hidden sm:block ${tableCls.wrap} opacity-60`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(6) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>檔案</th>
                  <th className={tableCls.thNum}>版本</th>
                  <th className={tableCls.th}>作廢原因</th>
                  <th className={tableCls.th}>作廢時間</th>
                  <th className={tableCls.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {voidedEntries.map((entry) => {
                  const u = entry.upload!;
                  return (
                    <tr key={u.id} className={tableCls.rowHover}>
                      <td className={`${tableCls.td} font-medium`}>{entry.site_name}</td>
                      <td className={tableCls.td}>{u.file_name}</td>
                      <td className={tableCls.tdNum}>v{u.version}</td>
                      <td className={tableCls.td}>{u.void_reason ?? "—"}</td>
                      <td className={tableCls.tdMuted}>{fmtDateTime(u.voided_at)}</td>
                      <td className={tableCls.td}>
                        <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                          睇詳情
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 opacity-60 sm:hidden">
            {voidedEntries.map((entry) => {
              const u = entry.upload!;
              return (
                <div key={u.id} className="rounded-lg border border-zk-border bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{entry.site_name}</span>
                    <Pill variant="neutral">已作廢</Pill>
                  </div>
                  <div className="mt-1 text-[11.5px] text-zk-muted">
                    {u.file_name} · v{u.version}
                  </div>
                  <div className="mt-1 text-[11.5px] text-zk-muted">原因：{u.void_reason ?? "—"}</div>
                  <div className="mt-1 text-[11.5px] text-zk-faint">{fmtDateTime(u.voided_at)}</div>
                  <div className="mt-2">
                    <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                      睇詳情
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 逐上載詳情 */}
      {selectedUploadId && (
        <div className="rounded-lg border border-zk-border bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[14px] font-semibold text-zk-text">
                {detail?.upload.file_name ?? "詳情"}
                {detail && <span className="ml-2 text-[12px] text-zk-muted">v{detail.upload.version} · 上載於 {fmtDateTime(detail.upload.uploaded_at)}</span>}
                {detail?.upload.status === "voided" && <span className="ml-2 text-[12px] text-red-600">已作廢：{detail.upload.void_reason}</span>}
              </div>
              {detail?.upload.layout_key && <div className="text-[11.5px] text-zk-faint">layout: {detail.upload.layout_key}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12.5px] text-zk-muted">
                篩選
                <select
                  className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                  value={matchFilter}
                  onChange={(e) => setMatchFilter(e.target.value as typeof matchFilter)}
                  data-testid="roster-upload-match-filter"
                >
                  <option value="">全部</option>
                  <option value="unmatched">只顯示未配對</option>
                  <option value="ambiguous">只顯示多個候選</option>
                  <option value="by_name">只顯示淨係姓名配對</option>
                  <option value="staff_no_mismatch">只顯示工號不一致</option>
                  <option value="stale_staff_no">只顯示用已取消舊號配對</option>
                  <option value="name_only">只顯示淨靠姓名配對</option>
                </select>
              </label>
              {detail?.upload.status !== "voided" && (
                <Button variant="secondary" onClick={() => selectedUploadId && doReparse(selectedUploadId)}>
                  重新解析
                </Button>
              )}
              {detail && detail.upload.status !== "voided" && detail.upload.status !== "confirmed" && (
                <ConfirmVoidButton label="作廢" confirmLabel="確認作廢" onConfirm={(reason) => onVoidUpload(detail.upload.id, reason)} />
              )}
              <Button variant="secondary" onClick={() => setSelectedUploadId(null)}>
                收起
              </Button>
            </div>
          </div>

          {detail && (detail.name_only_count ?? 0) > 0 && (
            <div className="mb-3 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-[12px] text-orange-800" data-testid="roster-upload-name-only-warning">
              {detail.name_only_count} 格{detail.name_only_warning ?? "淨靠姓名配對，建議補工號或電話"}
            </div>
          )}

          {detail?.upload.parse_summary && detail.upload.parse_summary.warnings.length > 0 && (
            <ul className="mb-3 list-disc space-y-0.5 rounded-md border border-orange-200 bg-orange-50 py-2 pl-6 pr-3 text-[12px] text-orange-800" data-testid="roster-upload-summary-warnings">
              {detail.upload.parse_summary.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {detailLoading && !detail && <div className="py-6 text-center text-[13px] text-zk-muted">載入緊…</div>}

          {detail && (
            <>
            <div className="mb-1.5 text-[12px] text-zk-muted" data-testid="roster-upload-rows-count">
              已載入 {detail.rows.rows.length}／共 {detail.rows.total} 格
            </div>
            <div className={`overflow-x-auto rounded-md border border-zk-border`}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(7) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>日期</th>
                    <th className={tableCls.th}>代號</th>
                    <th className={tableCls.th}>更種</th>
                    <th className={tableCls.th}>安員配對</th>
                    <th className={tableCls.th}>雞頭碼</th>
                    <th className={tableCls.th}>子盤</th>
                    <th className={tableCls.th}>警告</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.rows.length === 0 && (
                    <tr>
                      <td className={tableCls.tdMuted} colSpan={7}>
                        冇符合條件嘅記錄
                      </td>
                    </tr>
                  )}
                  {detail.rows.rows.map((r) => {
                    const style = shiftCodeStyle(r.raw_code, { isLeave: r.code_kind === "leave" });
                    return (
                      <tr key={r.id} className={tableCls.rowHover}>
                        <td className={tableCls.td}>{fmtDate(r.work_date)}</td>
                        <td className={tableCls.td}>
                          <span
                            className="inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: style.bg, color: style.fg, border: style.border }}
                          >
                            {r.raw_code}
                          </span>
                        </td>
                        <td className={tableCls.td}>{r.code_kind}</td>
                        <td className={tableCls.td}>
                          <Pill variant={r.guard_match === "unmatched" || r.guard_match === "ambiguous" ? "warning" : "success"}>{GUARD_MATCH_LABEL[r.guard_match]}</Pill>
                          {r.name_raw && <span className="ml-1.5 text-[11.5px] text-zk-muted">{r.name_raw}</span>}
                        </td>
                        <td className={tableCls.td}>{r.broker_code_raw ?? "—"}</td>
                        <td className={tableCls.td}>
                          {r.sub_site_name ?? "—"}
                          {r.sub_site_name && !r.resolved_site_id && <span className="ml-1 text-[11px] text-orange-600">（子盤未配對）</span>}
                        </td>
                        <td className={`${tableCls.td} text-[11.5px] text-orange-700`}>{r.warnings && r.warnings.length ? r.warnings.join("；") : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {detail.rows.rows.length < detail.rows.total && (
              <div className="mt-2 text-center">
                <Button variant="secondary" disabled={detailLoading} onClick={() => selectedUploadId && loadDetail(selectedUploadId, matchFilter || undefined, true)}>
                  {detailLoading ? "載入緊…" : "載入更多"}
                </Button>
              </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
