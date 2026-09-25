"use client";
// WP-GUARD-FIX-UI（老闆 2026-09-25 要求，緊急，直接影響出糧）：「未配對
// 安員修復」做入系統——老闆手機撳兩下就搞掂，唔使再喺 Terminal 貼 DB
// 連線字串。呢個 module（`安員配對修復`）淨係老闆（`src/lib/rbac/
// matrix.ts`），會批量建人、睇 U Team 名單身份證。
//
// 流程：① 上載 U Team 名單（拖放，現用一份）→ ② 揀月份「計算修復計劃」
// → 摘要卡＋needs_boss 逐條 → ③「套用」confirm→進度→結果（逐盤修復
// 前後表＋剩餘清單）→ ④ 歷史 runs。手機 375px 用得。
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, selectCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
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
}

interface PlanResponse {
  run_id: string;
  month: string;
  staff_list_upload: { id: string; file_name: string; uploaded_at: string; row_count: number };
  summary: PlanSummary;
  needs_boss: NeedsBossItem[];
}

interface RunListItem {
  id: string;
  month: string;
  status: "planned" | "applying" | "applied" | "failed";
  created_at: string;
  applied_at: string | null;
  summary: PlanSummary;
  result: { diffs?: unknown; reparse?: { total_before: number; total_after: number; per_upload: Array<{ site_label: string; before: { unmatched: number; ambiguous: number }; after: { unmatched: number; ambiguous: number } }> }; error?: string } | null;
  staff_list_file_name: string;
}

const STATUS_LABEL: Record<string, string> = { planned: "已計劃", applying: "套用緊…", applied: "已套用", failed: "失敗" };

export default function GuardFixPage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [currentStaffList, setCurrentStaffList] = useState<StaffListDTO | null>(null);
  const [uploadingList, setUploadingList] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [month, setMonth] = useState(currentMonthStr());
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);

  const [applying, setApplying] = useState(false);
  const [confirmingApply, setConfirmingApply] = useState(false);

  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  async function loadStaffList() {
    const res = await apiGet<{ current: StaffListDTO | null }>("/api/guard-fix/staff-list");
    if (res.ok) setCurrentStaffList(res.data.current);
  }
  async function loadRuns() {
    setRunsLoading(true);
    const res = await apiGet<{ runs: RunListItem[] }>("/api/guard-fix/runs");
    setRunsLoading(false);
    if (res.ok) setRuns(res.data.runs);
  }

  useEffect(() => {
    void loadStaffList();
    void loadRuns();
  }, []);

  async function onListFiles(files: FileList) {
    const file = files[0];
    if (!file) return;
    setUploadingList(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    const res = await apiUpload<{ upload: StaffListDTO; parse_ok: boolean; parse_error: string | null }>("/api/guard-fix/staff-list", form);
    setUploadingList(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (!res.data.parse_ok) {
      setError(`上載成功但解析失敗：${res.data.parse_error ?? "未知原因"}`);
      return;
    }
    setNotice(`名單已上載（${res.data.upload.row_count} 行）`);
    await loadStaffList();
  }

  async function onBuildPlan() {
    setPlanning(true);
    setError(null);
    setPlan(null);
    const res = await apiPost<PlanResponse>("/api/guard-fix/plan", { month });
    setPlanning(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPlan(res.data);
    await loadRuns();
  }

  async function pollRunUntilDone(runId: string): Promise<RunListItem | null> {
    for (let i = 0; i < 300; i++) {
      const res = await apiGet<RunListItem>(`/api/guard-fix/runs/${runId}`);
      if (!res.ok) return null;
      if (res.data.status === "applied" || res.data.status === "failed") return res.data;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  async function onApply() {
    if (!plan) return;
    setConfirmingApply(false);
    setApplying(true);
    setError(null);
    setNotice(null);
    const res = await apiPost<{ run_id: string; status: string }>(`/api/guard-fix/runs/${plan.run_id}/apply`);
    if (!res.ok) {
      setApplying(false);
      setError(res.message);
      return;
    }
    const finalRun = res.data.status === "applying" ? await pollRunUntilDone(plan.run_id) : await (async () => {
      const r = await apiGet<RunListItem>(`/api/guard-fix/runs/${plan.run_id}`);
      return r.ok ? r.data : null;
    })();
    setApplying(false);
    if (!finalRun || finalRun.status === "failed") {
      setError(finalRun?.result?.error ?? "套用失敗，請重新整理頁面查看歷史 runs");
      await loadRuns();
      return;
    }
    setNotice("已套用完成");
    setPlan(null);
    await loadRuns();
  }

  const willCreateCount = plan ? plan.summary.create + plan.summary.create_minimal : 0;

  return (
    <div className="space-y-4">
      <PageHeader kicker="排更" title="未配對安員修復" subtitle="8 月更表大量「未配對」安員——上載 U Team 名單、計算修復計劃、一撳套用，代替喺 Terminal 貼 DB 連線字串。" />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {/* ① U Team 名單上載 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">① U Team 名單</div>
        {currentStaffList ? (
          <div className="mb-3 text-[13px] text-zk-muted">
            現用：{currentStaffList.file_name}（{fmtDateTime(currentStaffList.uploaded_at)} 上載，共 {currentStaffList.row_count} 行）
          </div>
        ) : (
          <div className="mb-3 text-[13px] text-zk-muted">未上載過名單——請先上載先可以計算修復計劃。</div>
        )}
        <div
          data-testid="staff-list-dropzone"
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
          onClick={() => document.getElementById("staff-list-file-input")?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
            dragOver ? "border-[#2563eb] bg-blue-50" : "border-zk-border bg-zk-surface"
          }`}
        >
          <div className="text-[13px] font-medium text-zk-text">{uploadingList ? "上載緊…" : "拖放 U Team 名單 xlsx 到呢度，或者撳呢度揀檔"}</div>
          <div className="text-[12px] text-zk-muted">上載新一份會取代現用嗰份（用嚟計劃嘅永遠係最新一份）</div>
          <input
            id="staff-list-file-input"
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void onListFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* ② 計算計劃 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-zk-text">② 計算修復計劃</div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="月份">
            <input type="month" className={selectCls} value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={planning || !currentStaffList} onClick={onBuildPlan}>
            {planning ? "計算緊…" : "計算修復計劃"}
          </Button>
        </div>

        {plan && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryTile label="補工號／別名" value={plan.summary.link} />
              <SummaryTile label="新建安員" value={plan.summary.create + plan.summary.create_minimal} />
              <SummaryTile label="要老闆決定" value={plan.summary.needs_boss} warn={plan.summary.needs_boss > 0} />
              <SummaryTile label="身份證缺（要 HR 補）" value={plan.summary.hkid_dropped_count} />
            </div>
            <div className="text-[12.5px] text-zk-muted">
              呢個月共 {plan.summary.total_identities} 個身份（{plan.summary.total_cells} 格未配對）——名單：{plan.staff_list_upload.file_name}
            </div>

            {plan.needs_boss.length > 0 && (
              <div>
                <div className="mb-1 text-[13px] font-medium text-zk-text">要老闆決定（{plan.needs_boss.length} 項）</div>
                <div className="space-y-2">
                  {plan.needs_boss.map((n) => (
                    <div key={n.seq} className="rounded border border-amber-200 bg-amber-50 p-2.5 text-[12.5px]">
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

            <div className="flex items-center gap-2">
              <Button variant="dark" disabled={applying} onClick={() => setConfirmingApply(true)}>
                {applying ? "套用緊…（可能要幾分鐘，唔使留喺呢頁）" : "③ 套用"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {confirmingApply && plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4">
            <div className="mb-2 text-[15px] font-semibold text-zk-text">確認套用</div>
            <div className="mb-4 text-[13px] text-zk-muted">
              會建 {willCreateCount} 位新安員、幫 {plan.summary.link} 位登記工號／加別名，然後自動重新配對呢個月全部更表。套用之後可以再撳一次「計算修復計劃」睇仲剩幾多。
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmingApply(false)}>
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
          <div className="overflow-x-auto">
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(6) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>月份</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.th}>名單</th>
                  <th className={tableCls.th}>摘要</th>
                  <th className={tableCls.th}>修復前→後</th>
                  <th className={tableCls.th}>時間</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={tableCls.td}>{r.month}</td>
                    <td className={tableCls.td}>
                      <Pill variant={r.status === "applied" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</Pill>
                    </td>
                    <td className={tableCls.td}>{r.staff_list_file_name}</td>
                    <td className={tableCls.td}>
                      link {r.summary.link}／新建 {r.summary.create + r.summary.create_minimal}／要決定 {r.summary.needs_boss}
                    </td>
                    <td className={tableCls.td}>{r.result?.reparse ? `${r.result.reparse.total_before}→${r.result.reparse.total_after} 格` : "—"}</td>
                    <td className={tableCls.td}>{fmtDateTime(r.applied_at ?? r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
