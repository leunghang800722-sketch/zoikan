"use client";
// P3-3.5：由 `/guard-fix` 頁搬入 `/roster-uploads?tab=fix`（「未配對保安員修復」tab）——邏輯一字不改，
// 淨係：頁首由父頁出、月份用父頁嘅 MonthPicker（prop）、兩個 CSV 過渡面板收入 <details>、「歷史 runs」改「過往紀錄」預設收起。
// WP-GUARD-FIX-UI（老闆 2026-09-25 要求，緊急，直接影響出糧）：「未配對
// 保安員修復」做入系統——老闆手機撳兩下就搞掂，唔使再喺 Terminal 貼 DB
// 連線字串。呢個 module（`保安員配對修復`）淨係老闆（`src/lib/rbac/
// matrix.ts`），會批量建人、睇 U Team 名單身份證。
//
// 流程：① 上載 U Team 名單（拖放，現用一份）→ ② 揀月份「計算修復計劃」
// → 摘要卡＋needs_boss 逐條 → ③「套用」confirm→進度→結果（逐盤修復
// 前後表＋剩餘清單）→ ④ 過往紀錄。手機 375px 用得。
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { selectCls } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/DataTable";
import { apiGet, apiPost, apiUpload } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { fmtDateTime } from "@/lib/ui/format";

interface StaffListDTO {
  id: string;
  uploaded_at: string;
  file_name: string;
  file_size: number;
  row_count: number;
  status: string;
  parse_summary: { row_count: number; u_number_count: number; hkid_valid_count: number; hkid_invalid_count: number; parse_error: string | null } | null;
}

// 驗收修正：雞頭稱呼對應——GET /api/brokers 淨係要 id/code/name 揀「揀系統雞頭」下拉。
interface BrokerOption {
  id: string;
  code: string;
  name: string;
}

interface PostorderDTO {
  id: string;
  month: string;
  uploaded_at: string;
  file_name: string;
  file_size: number;
  row_count: number;
  status: string;
  parse_summary: {
    longterm_site_count: number;
    longterm_post_pair_count: number;
    longterm_cell_count: number;
    referral_row_count: number;
    referral_total_excel_amount: number;
    visa_supported: boolean;
    missing_sheets: string[];
    // WP-POSTORDER-ROBUST（老闆 2026-09-27 緊急）：Roster 表頭偵測診斷——
    // 上載即刻俾操作員睇「解析到幾多」，0 就要即刻知道去檢查緊 CSV。
    roster_header_row: number | null;
    roster_day_block_width: number | null;
    roster_first_day_col: number | null;
    parse_error: string | null;
    // WP-POSTORDER-PO-PAIRS：淨係上載 PostOrder.csv（冇 Roster／
    // pairs）嗰陣，長工組合唔喺呢個上載即刻計（要 DB 保安員名），淨係
    // 喺度俾個提示——真正組合喺「計算修復計劃」先計埋（見 plan.ts）。
    longterm_pairs_from_postorder?: number;
    longterm_cells_from_postorder?: number;
  } | null;
}

interface NeedsBossItem {
  seq: string;
  cells: Array<{ site_label: string; cell_count: number }>;
  total_cell_count: number;
  reason: string;
  name_raw?: string;
  staff_no_raw?: string | null;
  tel_raw?: string | null;
  candidates?: Array<{ id: string; name_zh: string }>;
}

interface PlanSummary {
  total_identities: number;
  total_cells: number;
  link: number;
  create: number;
  create_minimal: number;
  needs_boss: number;
  hkid_dropped_count: number;
  set_longterm?: number;
  set_longterm_post?: number;
  set_referral?: number;
  set_referral_inferred?: number;
  set_visa?: number;
}

interface ReparseResult {
  total_before: number;
  total_after: number;
  confirmed_skipped_count?: number;
  per_upload: Array<{ site_label: string; upload_id: string; before: { unmatched: number; ambiguous: number }; after: { unmatched: number; ambiguous: number } }>;
}
interface DiffResult {
  create: string[];
  skip: string[];
}
interface RunResult {
  diffs?: {
    link: DiffResult;
    create: DiffResult;
    create_minimal: DiffResult;
    set_longterm?: DiffResult;
    set_longterm_post?: DiffResult;
    set_referral?: DiffResult;
    set_referral_inferred?: DiffResult;
    set_visa?: DiffResult;
  };
  reparse?: ReparseResult;
  error?: string;
}

type RunStatus = "planned" | "applying" | "applied" | "failed";

interface RunListItem {
  id: string;
  month: string;
  status: RunStatus;
  created_at: string;
  applied_at: string | null;
  apply_started_at: string | null;
  apply_allowed: boolean;
  summary: PlanSummary;
  result: RunResult | null;
  staff_list_file_name: string;
}

interface RunDetail {
  id: string;
  month: string;
  status: RunStatus;
  created_at: string;
  applied_at: string | null;
  apply_started_at: string | null;
  apply_allowed: boolean;
  summary: PlanSummary;
  result: RunResult | null;
  staff_list_upload: { file_name: string; uploaded_at: string; row_count: number };
  postorder_upload: { file_name: string; uploaded_at: string } | null;
  needs_boss: NeedsBossItem[];
}

interface PlanResponse {
  run_id: string;
  month: string;
  staff_list_upload: { id: string; file_name: string; uploaded_at: string; row_count: number };
  postorder_upload: { id: string; file_name: string; uploaded_at: string } | null;
  summary: PlanSummary;
  postorder: {
    unresolved_site_labels: string[];
    unresolved_broker_labels: string[];
    visa_supported: boolean;
    visa_note: string;
    // WP-POSTORDER-PO-PAIRS：單靠 PostOrder.csv 補推咗幾多個 (盤,人) 組合
    // （已經計入上面「加長工崗位盤」嗰個數，呢度純粹俾操作員睇透明度）。
    longterm_pairs_from_postorder_count?: number;
  } | null;
  needs_boss: NeedsBossItem[];
}

/** 頁面「而家睇緊」嘅一個 run（啱啱計嘅計劃、或者套用完自動計嘅下一輪）。 */
interface ActivePlan {
  runId: string;
  month: string;
  summary: PlanSummary;
  needsBoss: NeedsBossItem[];
  staffListFileName: string;
  postorderFileName: string | null;
  postorder: PlanResponse["postorder"];
}

const STATUS_LABEL: Record<string, string> = { planned: "已計劃", applying: "套用緊…", applied: "已套用", failed: "失敗" };

function detailToActive(d: RunDetail): ActivePlan {
  return {
    runId: d.id,
    month: d.month.slice(0, 7),
    summary: d.summary,
    needsBoss: d.needs_boss,
    staffListFileName: d.staff_list_upload.file_name,
    postorderFileName: d.postorder_upload?.file_name ?? null,
    postorder: null,
  };
}

function actionCount(s: PlanSummary): number {
  return (
    s.link + s.create + s.create_minimal + (s.set_longterm ?? 0) + (s.set_longterm_post ?? 0) + (s.set_referral ?? 0) + (s.set_referral_inferred ?? 0) + (s.set_visa ?? 0)
  );
}

export default function GuardFixPanel({ month }: { month: string }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [currentStaffList, setCurrentStaffList] = useState<StaffListDTO | null>(null);
  const [uploadingList, setUploadingList] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // WP-LTSHIFT §19：Postorder 總表上載（同月份綁埋，揀月份先知上載去邊個月）。
  const [currentPostorder, setCurrentPostorder] = useState<PostorderDTO | null>(null);
  // WP-POSTORDER-ROBUST（老闆 2026-09-27 緊急）：歷史上載列表——一齊顯示
  // 長工格／介紹費行數，方便操作員睇返之前幾次上載係咪都解析到。
  const [postorderHistory, setPostorderHistory] = useState<PostorderDTO[]>([]);
  const [uploadingPostorder, setUploadingPostorder] = useState(false);
  const [dragOverPostorder, setDragOverPostorder] = useState(false);

  // WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員工具處理唔到
  // binary，改用 Google Sheets「下載為 CSV」——Roster／PostOrder 兩個
  // CSV 揀齊先可以撳「上載 CSV」（同 xlsm 拖放係另一條獨立路徑，揀咗
  // 一邊唔使理另一邊）。
  const [rosterCsvFile, setRosterCsvFile] = useState<File | null>(null);
  const [postorderCsvFile, setPostorderCsvFile] = useState<File | null>(null);
  const [uploadingPostorderCsv, setUploadingPostorderCsv] = useState(false);

  // WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：完整 Roster CSV 匯出
  // 持續 503——第三條路徑淨係要一個極精簡嘅 longterm-pairs.csv（可選
  // 再加 PostOrder.csv 計介紹費行）。
  const [pairsCsvFile, setPairsCsvFile] = useState<File | null>(null);
  const [pairsPostorderCsvFile, setPairsPostorderCsvFile] = useState<File | null>(null);
  const [uploadingPairsCsv, setUploadingPairsCsv] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<ActivePlan | null>(null);

  // 套用緊嘅 run id（頁面 poll 緊）——重新整理頁面都會由過往紀錄搵返。
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  const [confirmingApply, setConfirmingApply] = useState<{ runId: string; summary: PlanSummary; retry: boolean } | null>(null);
  const [lastResult, setLastResult] = useState<{ month: string; result: RunResult } | null>(null);

  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pollingRef = useRef<string | null>(null);

  // 驗收修正：雞頭稱呼對應——Postorder 對唔到嘅稱呼，逐個揀系統雞頭寫入 aliases。
  const [brokers, setBrokers] = useState<BrokerOption[]>([]);
  const [brokerAliasChoice, setBrokerAliasChoice] = useState<Record<string, string>>({});
  const [resolvingAliasLabel, setResolvingAliasLabel] = useState<string | null>(null);

  async function loadBrokers() {
    const res = await cachedGetAll<BrokerOption>("/api/brokers");
    if (res.ok) setBrokers(res.data.rows);
  }

  async function loadStaffList() {
    const res = await apiGet<{ current: StaffListDTO | null }>("/api/guard-fix/staff-list");
    if (res.ok) setCurrentStaffList(res.data.current);
  }
  async function loadPostorder(forMonth: string) {
    if (!/^\d{4}-\d{2}$/.test(forMonth)) return;
    const res = await apiGet<{ current: PostorderDTO | null; history: PostorderDTO[] }>(`/api/guard-fix/postorder?month=${forMonth}-01`);
    if (res.ok) {
      setCurrentPostorder(res.data.current);
      setPostorderHistory(res.data.history ?? []);
    }
  }
  async function loadRuns(): Promise<RunListItem[]> {
    setRunsLoading(true);
    const res = await apiGet<{ runs: RunListItem[] }>("/api/guard-fix/runs");
    setRunsLoading(false);
    if (!res.ok) return [];
    setRuns(res.data.runs);
    return res.data.runs;
  }

  useEffect(() => {
    void loadStaffList();
    void loadPostorder(month);
    void loadBrokers();
    void loadRuns().then((list) => {
      // 開頁（或者手機鎖機後重新整理）見到有 run 套用緊（未卡死）——即刻接住
      // poll，唔使老闆自己撳重新整理。
      const inFlight = list.find((r) => r.status === "applying" && !r.apply_allowed);
      if (inFlight) void followApply(inFlight.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadPostorder(month);
  }, [month]);

  async function onListFiles(files: FileList) {
    const file = files[0];
    if (!file) return;
    setUploadingList(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.set("file", file);
    const res = await apiUpload<{ upload: StaffListDTO; parse_ok: boolean; parse_error: string | null }>("/api/guard-fix/staff-list", form);
    setUploadingList(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!res.data.parse_ok) {
      setError(`上載成功但解析失敗：${res.data.parse_error ?? "未知原因"}——現用名單冇變，請檢查檔案係咪 U Team 名單（第一個 sheet）`);
      return;
    }
    setNotice(`名單已上載（${res.data.upload.row_count} 行）`);
    await loadStaffList();
  }

  async function onPostorderFiles(files: FileList) {
    const file = files[0];
    if (!file) return;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setError("請先揀番對應嘅月份（下面②）先上載 Postorder");
      return;
    }
    setUploadingPostorder(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.set("file", file);
    form.set("month", `${month}-01`);
    const res = await apiUpload<{ upload: PostorderDTO; parse_ok: boolean; parse_error: string | null }>("/api/guard-fix/postorder", form);
    setUploadingPostorder(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!res.data.parse_ok) {
      setError(`上載成功但解析失敗：${res.data.parse_error ?? "未知原因"}——請檢查係咪 Postorder 總表（要有 Roster／PostOrder 兩個 sheet）`);
      return;
    }
    // WP-POSTORDER-ROBUST：表頭搵到、解析冇 throw，但長工格淨係 0——都要
    // 紅字提示，唔可以靜靜當成功（呢個先係老闆話「1,295→0」嗰單嘅表徵）。
    if ((res.data.upload.parse_summary?.longterm_cell_count ?? 0) === 0) {
      setError("上載成功，但解析唔到長工格——請檢查係咪 Roster 分頁嘅 CSV");
      await loadPostorder(month);
      return;
    }
    setNotice(`Postorder 已上載（長工格 ${res.data.upload.parse_summary?.longterm_cell_count ?? 0}、介紹費行 ${res.data.upload.parse_summary?.referral_row_count ?? 0}）`);
    await loadPostorder(month);
  }

  // WP-POSTORDER-CSV：Roster／PostOrder 兩個 CSV 揀齊先撳得——正式站
  // 操作員工具處理唔到 binary，用 Google Sheets「下載為 CSV」代替。
  async function onPostorderCsvUpload() {
    if (!rosterCsvFile || !postorderCsvFile) {
      setError("要揀齊 Roster 同 PostOrder 兩個 CSV 先可以上載");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setError("請先揀番對應嘅月份（下面②）先上載 Postorder");
      return;
    }
    setUploadingPostorderCsv(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.set("roster_csv", rosterCsvFile);
    form.set("postorder_csv", postorderCsvFile);
    form.set("month", `${month}-01`);
    const res = await apiUpload<{ upload: PostorderDTO; parse_ok: boolean; parse_error: string | null }>("/api/guard-fix/postorder", form);
    setUploadingPostorderCsv(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!res.data.parse_ok) {
      setError(`上載成功但解析失敗：${res.data.parse_error ?? "未知原因"}——請檢查係咪 Roster／PostOrder 分頁匯出嘅 CSV`);
      return;
    }
    // WP-POSTORDER-ROBUST：同上面 xlsm 路徑一致——長工格 0 都要紅字提示。
    if ((res.data.upload.parse_summary?.longterm_cell_count ?? 0) === 0) {
      setError("上載成功，但解析唔到長工格——請檢查係咪 Roster 分頁嘅 CSV");
      setRosterCsvFile(null);
      setPostorderCsvFile(null);
      await loadPostorder(month);
      return;
    }
    setNotice(`Postorder CSV 已上載（長工格 ${res.data.upload.parse_summary?.longterm_cell_count ?? 0}、介紹費行 ${res.data.upload.parse_summary?.referral_row_count ?? 0}）`);
    setRosterCsvFile(null);
    setPostorderCsvFile(null);
    await loadPostorder(month);
  }

  // WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：淨係要一個
  // longterm-pairs.csv（PostOrder.csv 可選）——揀齊 pairs CSV 就撳得。
  // WP-POSTORDER-PO-PAIRS（老闆 2026-09-27 再緊急）：連 longterm-
  // pairs.csv 都傳唔到——`pairsCsvFile` 冇揀都照樣可以撳（淨係揀咗
  // PostOrder.csv），route 第四條路徑接受淨係 `postorder_csv`；(盤,人)
  // 組合喺「計算修復計劃」嗰刻先由 PostOrder.csv 補推（見
  // `src/lib/guard-fix/plan.ts` `mergeLongtermPostCells()`）。
  async function onPairsCsvUpload() {
    if (!pairsCsvFile && !pairsPostorderCsvFile) {
      setError("要揀 longterm-pairs.csv，或者淨係揀 PostOrder.csv，先可以上載");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setError("請先揀番對應嘅月份（下面②）先上載 Postorder");
      return;
    }
    setUploadingPairsCsv(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    if (pairsCsvFile) form.set("longterm_pairs_csv", pairsCsvFile);
    if (pairsPostorderCsvFile) form.set("postorder_csv", pairsPostorderCsvFile);
    form.set("month", `${month}-01`);
    const res = await apiUpload<{ upload: PostorderDTO; parse_ok: boolean; parse_error: string | null }>("/api/guard-fix/postorder", form);
    setUploadingPairsCsv(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!res.data.parse_ok) {
      setError(`上載成功但解析失敗：${res.data.parse_error ?? "未知原因"}——請檢查 CSV 表頭／內容`);
      return;
    }
    if (pairsCsvFile) {
      // longterm-pairs.csv 有帶——長工組合即刻計得埋，0 格就即刻紅字提示。
      if ((res.data.upload.parse_summary?.longterm_cell_count ?? 0) === 0) {
        setError("上載成功，但解析唔到長工格——請檢查 longterm-pairs.csv 內容");
        setPairsCsvFile(null);
        setPairsPostorderCsvFile(null);
        await loadPostorder(month);
        return;
      }
      setNotice(`長工組合 CSV 已上載（長工格 ${res.data.upload.parse_summary?.longterm_cell_count ?? 0}、介紹費行 ${res.data.upload.parse_summary?.referral_row_count ?? 0}）`);
    } else {
      // WP-POSTORDER-PO-PAIRS：淨係上載 PostOrder.csv——長工組合要「計算
      // 修復計劃」先計埋，呢度淨係俾個 PostOrder 補推提示（唔係最終數）。
      const pairs = res.data.upload.parse_summary?.longterm_pairs_from_postorder ?? 0;
      const cells = res.data.upload.parse_summary?.longterm_cells_from_postorder ?? 0;
      if (pairs === 0) {
        setError("上載成功，但 PostOrder.csv 淨係推唔到任何 (盤,人) 長工組合——請檢查係咪 PostOrder 分頁匯出嘅 CSV");
      } else {
        setNotice(`PostOrder.csv 已上載（單靠佢推到 ${pairs} 個 (盤,人) 組合、${cells} 格——實際套用數以「計算修復計劃」為準）、介紹費行 ${res.data.upload.parse_summary?.referral_row_count ?? 0}`);
      }
    }
    setPairsCsvFile(null);
    setPairsPostorderCsvFile(null);
    await loadPostorder(month);
  }

  async function onBuildPlan() {
    setPlanning(true);
    setError(null);
    setNotice(null);
    setPlan(null);
    setLastResult(null);
    const res = await apiPost<PlanResponse>("/api/guard-fix/plan", { month });
    setPlanning(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPlan({
      runId: res.data.run_id,
      month: res.data.month.slice(0, 7),
      summary: res.data.summary,
      needsBoss: res.data.needs_boss,
      staffListFileName: res.data.staff_list_upload.file_name,
      postorderFileName: res.data.postorder_upload?.file_name ?? null,
      postorder: res.data.postorder,
    });
    await loadRuns();
  }

  // 驗收修正：Postorder 對唔到嘅雞頭稱呼——揀完系統雞頭撳「對應」，寫入
  // brokers.aliases 之後自動重新計劃（唔使老闆自己再撳一次②）。
  async function onResolveBrokerAlias(label: string) {
    const brokerId = brokerAliasChoice[label];
    if (!brokerId) {
      setError("請先揀返對應嘅系統雞頭");
      return;
    }
    setResolvingAliasLabel(label);
    setError(null);
    setNotice(null);
    const res = await apiPost<{ broker: { id: string; code: string; name: string }; added: boolean }>("/api/guard-fix/broker-alias", { label, broker_id: brokerId });
    setResolvingAliasLabel(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await onBuildPlan();
    setNotice(`「${label}」已對應去 ${res.data.broker.code}，已經自動重新計劃。`);
  }

  // P3-0.6（B-10）：unmount 即停 polling（唔再打 API／setState）。
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  async function pollRunUntilDone(runId: string): Promise<RunDetail | null> {
    // 最多 poll 40 分鐘（apply transaction timeout 30 分鐘＋reparse）。
    for (let i = 0; i < 1200; i++) {
      if (unmountedRef.current) return null;
      const res = await apiGet<RunDetail>(`/api/guard-fix/runs/${runId}`);
      if (res.ok && (res.data.status === "applied" || res.data.status === "failed")) return res.data;
      if (res.ok && res.data.status === "applying" && res.data.apply_allowed) return res.data; // 卡死（>15 分鐘）
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  /** 跟住一個套用緊嘅 run 直至完成：顯示結果，自動帶出下一輪計劃。 */
  async function followApply(runId: string) {
    if (pollingRef.current === runId) return;
    pollingRef.current = runId;
    setApplyingRunId(runId);
    setPlan(null);
    const finalRun = await pollRunUntilDone(runId);
    pollingRef.current = null;
    if (unmountedRef.current) return;
    setApplyingRunId(null);
    const list = await loadRuns();
    if (!finalRun) {
      setHistoryOpen(true);
      setError("套用仲未完成（等咗 40 分鐘）——請稍後撳「重新整理」睇過往紀錄");
      return;
    }
    if (finalRun.status === "applying") {
      setHistoryOpen(true);
      setError("套用超過 15 分鐘都未完成（可能伺服器中途重啟）——喺下面過往紀錄撳「重新套用」（安全，唔會重複建人）");
      return;
    }
    if (finalRun.status === "failed") {
      setHistoryOpen(true);
      setError(`套用失敗：${finalRun.result?.error ?? "未知原因"}——可以喺下面過往紀錄撳「重新套用」，或者重新計算修復計劃`);
      return;
    }
    setLastResult({ month: finalRun.month.slice(0, 7), result: finalRun.result ?? {} });
    // 套用完成後伺服器會自動計下一輪計劃（同月、同一份名單）——帶出嚟俾
    // 老闆睇仲剩幾多、要唔要再套用一次。
    const nextNewest = list.filter((r) => r.status === "planned" && r.month === finalRun.month && r.created_at >= (finalRun.applied_at ?? "")).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (nextNewest) {
      const d = await apiGet<RunDetail>(`/api/guard-fix/runs/${nextNewest.id}`);
      if (d.ok) setPlan(detailToActive(d.data));
      const remaining = actionCount(nextNewest.summary);
      setNotice(
        remaining > 0
          ? `已套用完成。下一輪仲有 ${remaining} 項可以自動修——再撳一次「③ 套用」`
          : `已套用完成。已經收斂——剩低 ${nextNewest.summary.needs_boss} 項要老闆逐項決定（見下面）`,
      );
    } else {
      setNotice("已套用完成");
    }
  }

  async function onApply() {
    if (!confirmingApply) return;
    const { runId } = confirmingApply;
    setConfirmingApply(null);
    setError(null);
    setNotice(null);
    setLastResult(null);
    const res = await apiPost<{ run_id: string; status: string }>(`/api/guard-fix/runs/${runId}/apply`);
    if (!res.ok) {
      setError(res.message);
      await loadRuns();
      return;
    }
    await followApply(runId);
  }

  const applyingNow = applyingRunId !== null;

  return (
    <div className="space-y-4">
      <div className="text-[13px] text-zk-muted">更表大量「未配對」保安員——上載 U Team 名單、計算修復計劃、一撳套用。月份跟頁首嘅月份選擇器。</div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {applyingNow && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-[13px] text-zk-text" data-testid="guard-fix-applying">
          套用緊…（建人＋重新配對全部更表，可能要幾分鐘）。可以留喺呢頁等；熄咗屏或者離開都唔會中斷，返嚟打開呢頁會自動接住。
        </div>
      )}

      {/* ① U Team 名單上載 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">① U Team 名單</div>
        {currentStaffList ? (
          <div className="mb-3 break-all text-[13px] text-zk-muted">
            現用：{currentStaffList.file_name}（{fmtDateTime(currentStaffList.uploaded_at)} 上載，共 {currentStaffList.row_count} 行）
          </div>
        ) : (
          <div className="mb-3 text-[13px] text-zk-muted">未上載過名單——請先上載先可以計算修復計劃。</div>
        )}
        <label
          data-testid="staff-list-dropzone"
          htmlFor="staff-list-file-input"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) void onListFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
            dragOver ? "border-[#2563eb] bg-blue-50" : "border-zk-border bg-zk-surface"
          }`}
        >
          <div className="text-[13px] font-medium text-zk-text">{uploadingList ? "上載緊…" : "撳呢度揀 U Team 名單 xlsx（電腦可以拖放）"}</div>
          <div className="text-[12px] text-zk-muted">上載新一份會取代現用嗰份（用嚟計劃嘅永遠係最新一份）</div>
          <input
            id="staff-list-file-input"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={uploadingList}
            onChange={(e) => {
              if (e.target.files?.length) void onListFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {/* ①b Postorder 總表上載（WP-LTSHIFT §19） */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">①b Postorder 總表（長工崗位／介紹費，選填）</div>
        {currentPostorder ? (
          <div className="mb-3 text-[13px]">
            <div className="break-all text-zk-muted">
              {month} 現用：{currentPostorder.file_name}（{fmtDateTime(currentPostorder.uploaded_at)} 上載）
              {currentPostorder.parse_summary && (
                <>
                  　長工格 {currentPostorder.parse_summary.longterm_cell_count}（{currentPostorder.parse_summary.longterm_post_pair_count} 組）・介紹費行{" "}
                  {currentPostorder.parse_summary.referral_row_count}（${currentPostorder.parse_summary.referral_total_excel_amount}）
                </>
              )}
            </div>
            {/* WP-POSTORDER-ROBUST（老闆 2026-09-27 緊急）：長工格 0 就即刻
                紅字提示——之前解析器靜靜計到 0 都當上載成功，操作員睇唔出
                個計劃點解「加長工崗位盤／定做長工」係 0。 */}
            {currentPostorder.parse_summary && currentPostorder.parse_summary.longterm_cell_count === 0 && (
              <div className="mt-1 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12.5px] text-red-700">
                解析唔到長工格——請檢查係咪 Roster 分頁嘅 CSV
                {currentPostorder.parse_summary.parse_error ? `（${currentPostorder.parse_summary.parse_error}）` : ""}
                {currentPostorder.parse_summary.roster_header_row !== null && (
                  <>
                    　（表頭：第 {currentPostorder.parse_summary.roster_header_row} 行，逐日 block 闊度{" "}
                    {currentPostorder.parse_summary.roster_day_block_width ?? "搵唔到"}）
                  </>
                )}
              </div>
            )}
            {postorderHistory.length > 1 && (
              <ul className="mt-2 divide-y divide-zk-border rounded border border-zk-border text-[12px]">
                {postorderHistory.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-x-2 px-2 py-1">
                    <span className="min-w-0 break-all text-zk-muted">
                      {fmtDateTime(h.uploaded_at)}・{h.file_name}
                    </span>
                    <span className={`shrink-0 tabular-nums ${h.parse_summary?.longterm_cell_count === 0 ? "font-medium text-red-600" : "text-zk-muted"}`}>
                      長工格 {h.parse_summary?.longterm_cell_count ?? "?"}・介紹費行 {h.parse_summary?.referral_row_count ?? "?"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mb-3 text-[13px] text-zk-muted">
            {month} 未上載過 Postorder 總表——唔上載都可以計劃（set_longterm/set_longterm_post/set_referral 一律 0 項；「定介紹雞頭（推算）」唔靠 Postorder，一樣會計）。
          </div>
        )}
        <label
          data-testid="postorder-dropzone"
          htmlFor="postorder-file-input"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverPostorder(true);
          }}
          onDragLeave={() => setDragOverPostorder(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverPostorder(false);
            if (e.dataTransfer.files.length) void onPostorderFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
            dragOverPostorder ? "border-[#2563eb] bg-blue-50" : "border-zk-border bg-zk-surface"
          }`}
        >
          <div className="text-[13px] font-medium text-zk-text">{uploadingPostorder ? "上載緊…" : `撳呢度揀 Postorder 總表（.xlsm/.xlsx，對應 ${month}）`}</div>
          <div className="text-[12px] text-zk-muted">上載新一份會取代呢個月現用嗰份</div>
          <input
            id="postorder-file-input"
            type="file"
            accept=".xlsm,.xlsx,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={uploadingPostorder}
            onChange={(e) => {
              if (e.target.files?.length) void onPostorderFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {/* P3-3.5（老闆 4A）：兩個 CSV 過渡面板收入「其他上載方式」，預設收起。 */}
        <details className="mt-3" data-testid="guard-fix-other-uploads">
          <summary className="cursor-pointer text-[12.5px] font-medium text-zk-primary">其他上載方式（9 月過渡用）</summary>
        {/* WP-POSTORDER-CSV（老闆 2026-09-26 緊急）：正式站操作員工具讀唔到
            binary，改用 Google Sheets「下載為 CSV」——呢度加兩個 CSV 檔案
            輸入（Roster／PostOrder 分頁各一份），效果同上面 .xlsm 上載一樣。 */}
        <div className="mt-3 rounded-lg border border-zk-border bg-zk-surface p-3">
          <div className="mb-1.5 text-[13px] font-medium text-zk-text">或者上載兩個 CSV（Roster 分頁、PostOrder 分頁）</div>
          <div className="mb-2 text-[12px] leading-relaxed text-zk-muted">
            正式站帳號讀唔到 .xlsm／.xlsx：喺 Google Drive 用「Google Sheets」打開 Postorder 總表→左上「檔案」→「下載」→「逗號分隔值檔案
            (.csv)（現時工作表）」，Roster 同 PostOrder 兩個分頁分別匯出、揀返落嚟。
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="postorder-roster-csv-input" className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-[12.5px] ${rosterCsvFile ? "border-[#2563eb] bg-blue-50 text-[#2563eb]" : "border-zk-border text-zk-muted"}`}>
              {rosterCsvFile ? `Roster：${rosterCsvFile.name}` : "揀 Roster.csv"}
              <input
                id="postorder-roster-csv-input"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={uploadingPostorderCsv}
                onChange={(e) => {
                  setRosterCsvFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
            <label
              htmlFor="postorder-postorder-csv-input"
              className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-[12.5px] ${postorderCsvFile ? "border-[#2563eb] bg-blue-50 text-[#2563eb]" : "border-zk-border text-zk-muted"}`}
            >
              {postorderCsvFile ? `PostOrder：${postorderCsvFile.name}` : "揀 PostOrder.csv"}
              <input
                id="postorder-postorder-csv-input"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={uploadingPostorderCsv}
                onChange={(e) => {
                  setPostorderCsvFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <Button
            className="mt-2 w-full sm:w-auto"
            variant="secondary"
            disabled={!rosterCsvFile || !postorderCsvFile || uploadingPostorderCsv}
            onClick={() => void onPostorderCsvUpload()}
          >
            {uploadingPostorderCsv ? "上載緊…" : "上載 CSV"}
          </Button>
        </div>

        {/* WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：完整 Roster CSV
            匯出持續 503——加呢個極精簡路徑，淨係要「(盤,人) 組合＋格數」
            四欄 CSV（`site_label,site_short,guard_name,cell_count`，
            由已刪除嘅 `scripts/guard-fix/export-postorder-pairs.ts` 產生（2026-09-28 清走；而家改由 PostOrder.csv 推崗位，見 WP-POSTORDER-PO-PAIRS），或者
            人手／AI 對住 Roster 分頁逐盤逐人手抄），~3KB，人手／AI 都
            可以準確轉錄，PostOrder.csv（介紹費行）可選。 */}
        <div className="mt-3 rounded-lg border border-zk-border bg-zk-surface p-3">
          <div className="mb-1.5 text-[13px] font-medium text-zk-text">或上載精簡長工組合 CSV（longterm-pairs.csv）</div>
          <div className="mb-2 text-[12px] leading-relaxed text-zk-muted">
            完整 Roster 分頁匯出太大時用：淨係四欄 `site_label,site_short,guard_name,cell_count`——每行一個
            (盤,人) 組合同格數，約 60 行、幾 KB，人手或者 AI 對住 Roster 分頁轉錄都準確。PostOrder.csv（介紹費行）可選，唔上載都可以計劃長工崗位。
            <br />
            連呢個都傳唔到？<strong>淨係上載 PostOrder.csv 都得</strong>
            ——唔使揀 longterm-pairs.csv，(盤,人) 長工組合會喺「②計算修復計劃」嗰刻由 PostOrder.csv 自動補推（覆蓋率稍低過完整
            Roster，但唔使操作員手動轉錄）。
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label
              htmlFor="postorder-pairs-csv-input"
              className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-[12.5px] ${pairsCsvFile ? "border-[#2563eb] bg-blue-50 text-[#2563eb]" : "border-zk-border text-zk-muted"}`}
            >
              {pairsCsvFile ? `長工組合：${pairsCsvFile.name}` : "揀 longterm-pairs.csv"}
              <input
                id="postorder-pairs-csv-input"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={uploadingPairsCsv}
                onChange={(e) => {
                  setPairsCsvFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
            <label
              htmlFor="postorder-pairs-postorder-csv-input"
              className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-[12.5px] ${pairsPostorderCsvFile ? "border-[#2563eb] bg-blue-50 text-[#2563eb]" : "border-zk-border text-zk-muted"}`}
            >
              {pairsPostorderCsvFile ? `PostOrder：${pairsPostorderCsvFile.name}` : "揀 PostOrder.csv（可淨係揀呢個）"}
              <input
                id="postorder-pairs-postorder-csv-input"
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={uploadingPairsCsv}
                onChange={(e) => {
                  setPairsPostorderCsvFile(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <Button className="mt-2 w-full sm:w-auto" variant="secondary" disabled={(!pairsCsvFile && !pairsPostorderCsvFile) || uploadingPairsCsv} onClick={() => void onPairsCsvUpload()}>
            {uploadingPairsCsv ? "上載緊…" : pairsCsvFile ? "上載長工組合 CSV" : "淨係上載 PostOrder.csv"}
          </Button>
        </div>
        </details>
      </div>

      {/* ② 計算計劃 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">② 計算修復計劃</div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="text-[13px] text-zk-text" data-testid="guard-fix-month">
            月份：<span className="font-semibold">{month}</span>
          </div>
          <Button variant="primary" disabled={planning || applyingNow || !currentStaffList || !/^\d{4}-\d{2}$/.test(month)} onClick={onBuildPlan}>
            {planning ? "計算緊…" : "計算修復計劃"}
          </Button>
        </div>

        {lastResult?.result.reparse && (
          <div className="mt-4 space-y-2" data-testid="guard-fix-result">
            <div className="text-[13px] font-medium text-zk-text">
              {lastResult.month} 套用結果：未配對 {lastResult.result.reparse.total_before} → {lastResult.result.reparse.total_after} 格
              {lastResult.result.diffs
                ? `（補工號／別名 ${lastResult.result.diffs.link.create.length}、新建 ${lastResult.result.diffs.create.create.length + lastResult.result.diffs.create_minimal.create.length}）`
                : ""}
            </div>
            {!!lastResult.result.reparse.confirmed_skipped_count && (
              <div className="text-[12.5px] text-zk-muted">{lastResult.result.reparse.confirmed_skipped_count} 個上載已經對數確認，冇重新配對（已寫入嘅更唔郁）。</div>
            )}
            <ul className="divide-y divide-zk-border rounded border border-zk-border text-[12.5px]">
              {lastResult.result.reparse.per_upload
                .filter((u) => u.before.unmatched + u.before.ambiguous > 0 || u.after.unmatched + u.after.ambiguous > 0)
                .map((u) => (
                  <li key={u.upload_id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                    <span className="min-w-0 break-words text-zk-text">{u.site_label}</span>
                    <span className="shrink-0 tabular-nums text-zk-muted">
                      {u.before.unmatched + u.before.ambiguous} → {u.after.unmatched + u.after.ambiguous} 格
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {plan && (
          <div className="mt-4 space-y-3" data-testid="guard-fix-plan">
            <div className="text-[13px] font-medium text-zk-text">{plan.month} 修復計劃</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryTile label="補工號／別名" value={plan.summary.link} />
              <SummaryTile label="新建保安員" value={plan.summary.create + plan.summary.create_minimal} />
              <SummaryTile label="要老闆決定" value={plan.summary.needs_boss} warn={plan.summary.needs_boss > 0} />
              <SummaryTile label="身份證缺（要 HR 補）" value={plan.summary.hkid_dropped_count} />
              <SummaryTile label="定做長工" value={plan.summary.set_longterm ?? 0} />
              <SummaryTile label="加長工崗位盤" value={plan.summary.set_longterm_post ?? 0} />
              <SummaryTile label="定介紹雞頭" value={plan.summary.set_referral ?? 0} />
              <SummaryTile label="定介紹雞頭（推算）" value={plan.summary.set_referral_inferred ?? 0} />
              <SummaryTile label="定簽證贊助雞頭" value={plan.summary.set_visa ?? 0} />
            </div>
            <div className="break-all text-[12.5px] text-zk-muted">
              呢個月共 {plan.summary.total_identities} 個身份（{plan.summary.total_cells} 格未配對）——名單：{plan.staffListFileName}
              {plan.postorderFileName ? `；Postorder：${plan.postorderFileName}` : "；呢次冇上載 Postorder"}
              {plan.postorder && (plan.postorder.longterm_pairs_from_postorder_count ?? 0) > 0
                ? `（其中 ${plan.postorder.longterm_pairs_from_postorder_count} 個 (盤,人) 組合單靠 PostOrder.csv 補推）`
                : ""}
            </div>
            {plan.postorder && plan.postorder.unresolved_site_labels.length > 0 && (
              <div className="break-words rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px] text-amber-800">
                Postorder 對唔到嘅盤名（保守：唔建計劃，留 ≥50% 推算兜底）——{plan.postorder.unresolved_site_labels.join("、")}
              </div>
            )}

            {plan.postorder && plan.postorder.unresolved_broker_labels.length > 0 && (
              <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px] text-amber-800" data-testid="guard-fix-broker-alias">
                <div>Postorder 對唔到嘅雞頭稱呼（保守：唔建 set_referral，留 ≥50% 推算兜底）——逐個揀返對應嘅系統雞頭：</div>
                <div className="space-y-1.5">
                  {plan.postorder.unresolved_broker_labels.map((label) => (
                    <div key={label} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-medium text-amber-900">{label}</span>
                      <select
                        className={`${selectCls} max-w-[10rem]`}
                        value={brokerAliasChoice[label] ?? ""}
                        onChange={(e) => setBrokerAliasChoice((prev) => ({ ...prev, [label]: e.target.value }))}
                        disabled={resolvingAliasLabel !== null}
                      >
                        <option value="">（揀系統雞頭）</option>
                        {brokers.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.code}　{b.name}
                          </option>
                        ))}
                      </select>
                      <Button variant="secondary" disabled={!brokerAliasChoice[label] || resolvingAliasLabel !== null} onClick={() => void onResolveBrokerAlias(label)}>
                        {resolvingAliasLabel === label ? "對應緊…" : "對應"}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.needsBoss.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-zk-text">要老闆決定（{plan.needsBoss.length} 項，喺保安員頁／對數頁人手處理）</div>
                <div className="space-y-2">
                  {plan.needsBoss.map((n) => (
                    <div key={n.seq} className="break-words rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px]">
                      <div className="font-medium text-zk-text">
                        {n.name_raw ?? "（冇「保安員個人資料」查閱權限，睇唔到姓名）"}
                        {n.staff_no_raw ? `　工號：${n.staff_no_raw}` : ""}
                        {n.tel_raw ? `　電話：${n.tel_raw}` : ""}
                      </div>
                      <div className="mt-0.5 text-zk-muted">{n.cells.map((c) => `${c.site_label} ${c.cell_count} 格`).join("、")}</div>
                      <div className="mt-0.5 text-zk-muted">原因：{n.reason}</div>
                      {n.candidates && n.candidates.length > 0 && <div className="mt-0.5 text-zk-muted">候選：{n.candidates.map((c) => c.name_zh).join("、")}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {actionCount(plan.summary) > 0 ? (
              <div className="flex items-center gap-2">
                <Button variant="dark" disabled={applyingNow} onClick={() => setConfirmingApply({ runId: plan.runId, summary: plan.summary, retry: false })}>
                  {applyingNow ? "套用緊…" : "③ 套用"}
                </Button>
              </div>
            ) : (
              <div className="text-[12.5px] text-zk-muted">冇嘢可以自動修（淨係剩「要老闆決定」嗰啲）——唔使再套用。</div>
            )}
          </div>
        )}
      </div>

      {confirmingApply && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4">
            <div className="mb-2 text-[15px] font-semibold text-zk-text">{confirmingApply.retry ? "確認重新套用" : "確認套用"}</div>
            <div className="mb-4 text-[13px] text-zk-muted">
              會建 {confirmingApply.summary.create + confirmingApply.summary.create_minimal} 位新保安員、幫 {confirmingApply.summary.link} 位登記工號／加別名
              {(confirmingApply.summary.set_longterm ?? 0) +
                (confirmingApply.summary.set_longterm_post ?? 0) +
                (confirmingApply.summary.set_referral ?? 0) +
                (confirmingApply.summary.set_referral_inferred ?? 0) >
              0
                ? `、定 ${confirmingApply.summary.set_longterm ?? 0} 位做長工／加 ${confirmingApply.summary.set_longterm_post ?? 0} 個長工崗位盤／定 ${(confirmingApply.summary.set_referral ?? 0) + (confirmingApply.summary.set_referral_inferred ?? 0)} 個介紹雞頭`
                : ""}
              ，然後自動重新配對呢個月全部更表（已對數確認嘅唔郁）。
              {confirmingApply.retry ? "上次冇完成——重新套用唔會重複建人（已建嘅會跳過）。" : ""}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmingApply(null)}>
                取消
              </Button>
              <Button variant="dark" onClick={onApply}>
                確認套用
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ④ 過往紀錄（P3-3.5：預設收起；套用失敗／卡住提示會自動展開） */}
      <details open={historyOpen} onToggle={(e) => setHistoryOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border border-zk-border bg-white p-4" data-testid="guard-fix-history">
        <summary className="cursor-pointer text-[14px] font-semibold text-zk-text">過往紀錄{runs.length > 0 ? `（${runs.length}）` : ""}</summary>
        <div className="mb-2 mt-2 flex items-center justify-end">
          <Button variant="secondary" onClick={() => void loadRuns()} disabled={runsLoading}>
            重新整理
          </Button>
        </div>
        {runs.length === 0 ? (
          <EmptyState title="未計算過修復計劃" description="上載名單、揀月份，撳「計算修復計劃」。" />
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id} className="rounded border border-zk-border p-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zk-text">{r.month.slice(0, 7)}</span>
                    <Pill variant={r.status === "applied" ? "success" : r.status === "failed" ? "danger" : "neutral"}>
                      {r.status === "applying" && r.apply_allowed ? "卡住（超過 15 分鐘）" : (STATUS_LABEL[r.status] ?? r.status)}
                    </Pill>
                  </div>
                  <span className="text-zk-muted">{fmtDateTime(r.applied_at ?? r.apply_started_at ?? r.created_at)}</span>
                </div>
                <div className="mt-1 text-zk-muted">
                  補工號／別名 {r.summary.link}・新建 {r.summary.create + r.summary.create_minimal}・要決定 {r.summary.needs_boss}
                  {r.result?.reparse ? `・未配對 ${r.result.reparse.total_before}→${r.result.reparse.total_after} 格` : ""}
                </div>
                {r.status === "failed" && r.result?.error && <div className="mt-1 break-words text-red-700">失敗原因：{r.result.error}</div>}
                {r.apply_allowed && r.status !== "planned" && (
                  <div className="mt-2">
                    <Button variant="secondary" disabled={applyingNow} onClick={() => setConfirmingApply({ runId: r.id, summary: r.summary, retry: true })}>
                      重新套用
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

function SummaryTile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn && value > 0 ? "border-amber-300 bg-amber-50" : "border-zk-border bg-zk-surface"}`}>
      <div className="text-[12px] text-zk-muted">{label}</div>
      <div className={`mt-0.5 text-[20px] font-bold ${warn && value > 0 ? "text-amber-700" : "text-zk-text"}`}>{value}</div>
    </div>
  );
}
