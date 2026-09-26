"use client";
// WP-GUARD-FIX-UI（老闆 2026-09-25 要求，緊急，直接影響出糧）：「未配對
// 安員修復」做入系統——老闆手機撳兩下就搞掂，唔使再喺 Terminal 貼 DB
// 連線字串。呢個 module（`安員配對修復`）淨係老闆（`src/lib/rbac/
// matrix.ts`），會批量建人、睇 U Team 名單身份證。
//
// 流程：① 上載 U Team 名單（拖放，現用一份）→ ② 揀月份「計算修復計劃」
// → 摘要卡＋needs_boss 逐條 → ③「套用」confirm→進度→結果（逐盤修復
// 前後表＋剩餘清單）→ ④ 歷史 runs。手機 375px 用得。
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, selectCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { apiGet, apiPost, apiUpload } from "@/lib/ui/api-client";
import { fmtDateTime, currentMonthStr } from "@/lib/ui/format";

interface StaffListDTO {
  id: string;
  uploaded_at: string;
  file_name: string;
  file_size: number;
  row_count: number;
  status: string;
  parse_summary: { row_count: number; u_number_count: number; hkid_valid_count: number; hkid_invalid_count: number; parse_error: string | null } | null;
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
    parse_error: string | null;
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
  postorder: { unresolved_site_labels: string[]; unresolved_broker_labels: string[]; visa_supported: boolean; visa_note: string } | null;
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

/** 預設揀上個月（修復永遠係對已完結嘅月份更表，例如 9 月修 8 月）。 */
function previousMonthStr(): string {
  const [y, m] = currentMonthStr().split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

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
  return s.link + s.create + s.create_minimal + (s.set_longterm ?? 0) + (s.set_longterm_post ?? 0) + (s.set_referral ?? 0) + (s.set_visa ?? 0);
}

export default function GuardFixPage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [currentStaffList, setCurrentStaffList] = useState<StaffListDTO | null>(null);
  const [uploadingList, setUploadingList] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [month, setMonth] = useState(previousMonthStr());

  // WP-LTSHIFT §19：Postorder 總表上載（同月份綁埋，揀月份先知上載去邊個月）。
  const [currentPostorder, setCurrentPostorder] = useState<PostorderDTO | null>(null);
  const [uploadingPostorder, setUploadingPostorder] = useState(false);
  const [dragOverPostorder, setDragOverPostorder] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<ActivePlan | null>(null);

  // 套用緊嘅 run id（頁面 poll 緊）——重新整理頁面都會由歷史 runs 搵返。
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  const [confirmingApply, setConfirmingApply] = useState<{ runId: string; summary: PlanSummary; retry: boolean } | null>(null);
  const [lastResult, setLastResult] = useState<{ month: string; result: RunResult } | null>(null);

  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const pollingRef = useRef<string | null>(null);

  async function loadStaffList() {
    const res = await apiGet<{ current: StaffListDTO | null }>("/api/guard-fix/staff-list");
    if (res.ok) setCurrentStaffList(res.data.current);
  }
  async function loadPostorder(forMonth: string) {
    if (!/^\d{4}-\d{2}$/.test(forMonth)) return;
    const res = await apiGet<{ current: PostorderDTO | null }>(`/api/guard-fix/postorder?month=${forMonth}-01`);
    if (res.ok) setCurrentPostorder(res.data.current);
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
    setNotice(`Postorder 已上載（長工格 ${res.data.upload.parse_summary?.longterm_cell_count ?? 0}、介紹費行 ${res.data.upload.parse_summary?.referral_row_count ?? 0}）`);
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

  async function pollRunUntilDone(runId: string): Promise<RunDetail | null> {
    // 最多 poll 40 分鐘（apply transaction timeout 30 分鐘＋reparse）。
    for (let i = 0; i < 1200; i++) {
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
    setApplyingRunId(null);
    const list = await loadRuns();
    if (!finalRun) {
      setError("套用仲未完成（等咗 40 分鐘）——請稍後撳「重新整理」睇歷史 runs");
      return;
    }
    if (finalRun.status === "applying") {
      setError("套用超過 15 分鐘都未完成（可能伺服器中途重啟）——喺下面歷史 runs 撳「重新套用」（安全，唔會重複建人）");
      return;
    }
    if (finalRun.status === "failed") {
      setError(`套用失敗：${finalRun.result?.error ?? "未知原因"}——可以喺下面歷史 runs 撳「重新套用」，或者重新計算修復計劃`);
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
      <PageHeader kicker="排更" title="未配對安員修復" subtitle="更表大量「未配對」安員——上載 U Team 名單、計算修復計劃、一撳套用。" />

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
          <div className="mb-3 break-all text-[13px] text-zk-muted">
            {month} 現用：{currentPostorder.file_name}（{fmtDateTime(currentPostorder.uploaded_at)} 上載）
            {currentPostorder.parse_summary && (
              <>
                　長工格 {currentPostorder.parse_summary.longterm_cell_count}・介紹費行 {currentPostorder.parse_summary.referral_row_count}（$
                {currentPostorder.parse_summary.referral_total_excel_amount}）
              </>
            )}
          </div>
        ) : (
          <div className="mb-3 text-[13px] text-zk-muted">{month} 未上載過 Postorder 總表——唔上載都可以計劃（set_longterm/set_longterm_post/set_referral 一律 0 項）。</div>
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
      </div>

      {/* ② 計算計劃 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">② 計算修復計劃</div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="月份">
            <input type="month" className={selectCls} value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
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
              <SummaryTile label="新建安員" value={plan.summary.create + plan.summary.create_minimal} />
              <SummaryTile label="要老闆決定" value={plan.summary.needs_boss} warn={plan.summary.needs_boss > 0} />
              <SummaryTile label="身份證缺（要 HR 補）" value={plan.summary.hkid_dropped_count} />
              <SummaryTile label="定做長工" value={plan.summary.set_longterm ?? 0} />
              <SummaryTile label="加長工崗位盤" value={plan.summary.set_longterm_post ?? 0} />
              <SummaryTile label="定介紹雞頭" value={plan.summary.set_referral ?? 0} />
              <SummaryTile label="定簽證贊助雞頭" value={plan.summary.set_visa ?? 0} />
            </div>
            <div className="break-all text-[12.5px] text-zk-muted">
              呢個月共 {plan.summary.total_identities} 個身份（{plan.summary.total_cells} 格未配對）——名單：{plan.staffListFileName}
              {plan.postorderFileName ? `；Postorder：${plan.postorderFileName}` : "；呢次冇上載 Postorder"}
            </div>
            {plan.postorder && (plan.postorder.unresolved_site_labels.length > 0 || plan.postorder.unresolved_broker_labels.length > 0) && (
              <div className="break-words rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px] text-amber-800">
                Postorder 對唔到（保守：唔建計劃，留 ≥50% 推算兜底）——
                {plan.postorder.unresolved_site_labels.length > 0 && <>盤名：{plan.postorder.unresolved_site_labels.join("、")}　</>}
                {plan.postorder.unresolved_broker_labels.length > 0 && <>雞頭稱呼：{plan.postorder.unresolved_broker_labels.join("、")}</>}
              </div>
            )}

            {plan.needsBoss.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-zk-text">要老闆決定（{plan.needsBoss.length} 項，喺安員頁／對數頁人手處理）</div>
                <div className="space-y-2">
                  {plan.needsBoss.map((n) => (
                    <div key={n.seq} className="break-words rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px]">
                      <div className="font-medium text-zk-text">
                        {n.name_raw ?? "（冇「安員個人資料」查閱權限，睇唔到姓名）"}
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
              會建 {confirmingApply.summary.create + confirmingApply.summary.create_minimal} 位新安員、幫 {confirmingApply.summary.link} 位登記工號／加別名
              {(confirmingApply.summary.set_longterm ?? 0) + (confirmingApply.summary.set_longterm_post ?? 0) + (confirmingApply.summary.set_referral ?? 0) > 0
                ? `、定 ${confirmingApply.summary.set_longterm ?? 0} 位做長工／加 ${confirmingApply.summary.set_longterm_post ?? 0} 個長工崗位盤／定 ${confirmingApply.summary.set_referral ?? 0} 個介紹雞頭`
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

      {/* ④ 歷史 runs */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-zk-text">歷史 runs</div>
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
      </div>
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
