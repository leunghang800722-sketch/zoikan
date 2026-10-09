"use client";
// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：老闆／
// 會計每月：① 揀月份（預設上月）；② 拖入更表 xlsx（多檔）＋U Team 名單
// ＋Postorder（可選）；③ 撳「一鍵結算」；④ 睇逐步進度；⑤ 睇報告；
// ⑥「鎖定本月」（前置全綠先亮）；⑦ 歷史 runs。手機 375px 用得。
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { apiGet, apiPost, apiUpload } from "@/lib/ui/api-client";
import { fmtDateTime, fmtMoney, currentMonthStr, addMonthsStr } from "@/lib/ui/format";
import { MonthHealthCard } from "./MonthHealthCard";
import { MonthCloseTriageDialog } from "@/components/MonthCloseTriageDialog";
import { AutoSummaryCard, type AutoReportDTO } from "./AutoSummaryCard";

interface StepDTO {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  numbers: Record<string, unknown>;
  warnings: string[];
  needs_human: string[];
}

interface ReportDTO {
  month: string;
  totals: { revenue: number; margin_revenue?: number; cost: number; gross_margin: number; cost_basis?: "combined" | "legacy"; legacy_cost?: number; legacy_margin?: number };
  payroll_by_broker: Array<{ broker_code: string; broker_name: string; shifts: number; amount: number }>;
  site_revenue: Array<{ site_id: string; site_name: string; shifts: number; revenue: number }>;
  referral_fee: { total: number; count: number };
  unpriced: {
    count: number;
    payout_count: number;
    client_count: number;
    no_settlement_count: number;
    ot_unpriced_count: number;
    gap?: { records: number; client_gap_estimate: number | null; payout_gap_estimate: number | null; no_reference_records: number } | null;
  };
  /** WP-ONE-CLICK-AUTO §31.3 E：自動處理摘要＋要你睇＋撤銷狀態（舊 run 冇）。 */
  auto?: AutoReportDTO;
  postorder_compare: { uploaded: boolean; referral_excel_total: number | null; referral_system_total: number; referral_diff: number | null; note: string } | null;
  needs_human: string[];
  health?: { critical: number; warn: number; info: number } | null;
  lock_precondition: { current_month_already_locked: boolean; missing_upload_sites: string[]; unconfirmed_upload_sites: string[]; unpriced_count?: number; ready_to_lock: boolean };
  longterm_payroll_note: string;
  longterm_payroll?: { gross_total: number; autopay_total: number; mpf_ee_total: number; mpf_er_total: number; guard_count: number } | null;
  // §21 任務 5a：合併成本摘要（2026-08 起先有值，7 月 null）——更次成本／
  // 長工 Autopay／介紹費／合計／MPF ER（另列）。
  combined_cost_summary: {
    per_shift_cost_total: number;
    referral_fee_total: number;
    longterm_autopay_total: number;
    combined_cost_total: number;
    mpf_er_total: number;
    visa_passthrough_autopay_excluded?: number;
  } | null;
}

interface RunDTO {
  id: string;
  month: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  current_step: string | null;
  stalled: boolean;
  steps: StepDTO[];
  report: ReportDTO | null;
  error_message: string | null;
}

function stepPill(status: StepDTO["status"]) {
  if (status === "done") return <Pill variant="success">完成</Pill>;
  if (status === "running") return <Pill variant="shift">執行緊</Pill>;
  if (status === "failed") return <Pill variant="danger">失敗</Pill>;
  if (status === "skipped") return <Pill variant="neutral">略過</Pill>;
  return <Pill variant="neutral">等緊</Pill>;
}

export default function MonthCloseOneClickPage() {
  const [month, setMonth] = useState(() => addMonthsStr(currentMonthStr(), -1));
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rosterFiles, setRosterFiles] = useState<FileList | null>(null);
  const [staffListFile, setStaffListFile] = useState<File | null>(null);
  const [postorderFiles, setPostorderFiles] = useState<File[]>([]);
  const pollingRef = useRef<string | null>(null);
  const [triageOpen, setTriageOpen] = useState<string | null>(null);

  async function loadRuns() {
    const res = await apiGet<{ runs: RunDTO[] }>(`/api/month-close/one-click?month=${month}`);
    if (res.ok) setRuns(res.data.runs);
  }

  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    const running = runs.find((r) => r.status === "running" && !r.stalled);
    if (running && pollingRef.current !== running.id) {
      pollingRef.current = running.id;
      void pollUntilDone(running.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  async function pollUntilDone(runId: string) {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await apiGet<{ runs: RunDTO[] }>(`/api/month-close/one-click?month=${month}`);
      if (!res.ok) continue;
      setRuns(res.data.runs);
      const cur = res.data.runs.find((r) => r.id === runId);
      if (!cur || cur.status !== "running" || cur.stalled) break;
    }
    pollingRef.current = null;
  }

  async function uploadRosters() {
    if (!rosterFiles || rosterFiles.length === 0) return;
    setBusy(true);
    setError(null);
    let ok = 0;
    let fail = 0;
    for (const file of Array.from(rosterFiles)) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("month", month);
      const res = await apiUpload(`/api/roster-uploads`, fd);
      if (res.ok) ok++;
      else fail++;
    }
    setBusy(false);
    setNotice(`更表上載完成：成功 ${ok} 個${fail ? `，失敗 ${fail} 個` : ""}`);
    setRosterFiles(null);
  }

  async function uploadStaffList() {
    if (!staffListFile) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", staffListFile);
    const res = await apiUpload(`/api/guard-fix/staff-list`, fd);
    setBusy(false);
    if (!res.ok) setError(res.message);
    else setNotice("U Team 名單已上載");
    setStaffListFile(null);
  }

  // Opus 驗收：正式站操作員淨係上載得 CSV（讀唔到 .xlsm binary）——原版
  // 一律用 `file` 欄位送，CSV 會俾 route 當 xlsm 拒絕（「唔係 xlsx/xlsm
  // 檔案」）。而家按副檔名／檔名分流到 `POST /api/guard-fix/postorder`
  // 現有嘅四個入口（xlsm／roster_csv＋postorder_csv／longterm_pairs_csv
  // （＋postorder_csv）／淨 postorder_csv），同「安員配對修復」頁一致。
  async function uploadPostorder() {
    if (postorderFiles.length === 0) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    for (const f of postorderFiles) {
      const lower = f.name.toLowerCase();
      if (!lower.endsWith(".csv")) fd.append("file", f);
      else if (lower.includes("pair")) fd.append("longterm_pairs_csv", f);
      else if (lower.includes("roster")) fd.append("roster_csv", f);
      else fd.append("postorder_csv", f);
    }
    fd.append("month", month);
    const res = await apiUpload(`/api/guard-fix/postorder`, fd);
    setBusy(false);
    if (!res.ok) setError(res.message);
    else setNotice("Postorder 總表已上載（可選對照用）");
    setPostorderFiles([]);
  }

  async function startOneClick() {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ run_id: string; status: string }>(`/api/month-close/one-click`, { month });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await loadRuns();
  }

  async function rerun(runId: string) {
    setBusy(true);
    setError(null);
    const res = await apiPost(`/api/month-close/one-click/${runId}/rerun`);
    setBusy(false);
    if (!res.ok) setError(res.message);
    await loadRuns();
  }

  // WP-ONE-CLICK-AUTO §31.3 E：一撳還原呢個 run 所有 auto 改動。
  async function undoAuto(runId: string) {
    if (!window.confirm("還原呢次一鍵結算所有「自動」改動？（價卡作廢、別名移除、結算雞頭還原、自動配對還原；你喺分診題一撳確認嘅唔會還原）")) return;
    setBusy(true);
    setError(null);
    const res = await apiPost<{ undone: Record<string, number>; skipped: Array<{ kind: string; reason: string }>; already_undone: boolean }>(`/api/month-close/one-click/${runId}/undo-auto`);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const total = Object.values(res.data.undone).reduce((a, b) => a + b, 0);
    setNotice(res.data.already_undone ? "之前已經還原過" : `已還原 ${total} 項自動改動${res.data.skipped.length ? `；${res.data.skipped.length} 項保留（${res.data.skipped.map((x) => x.reason).slice(0, 2).join("；")}）` : ""}`);
    await loadRuns();
  }

  async function lockMonth() {
    setBusy(true);
    setError(null);
    const gen = await apiPost<{ month_close: { id: string } }>(`/api/month-closes/${month}/generate`);
    if (!gen.ok) {
      setBusy(false);
      setError(gen.message);
      return;
    }
    const res = await apiPost(`/api/month-closes/${gen.data.month_close.id}/lock`, {});
    setBusy(false);
    if (!res.ok) setError(res.message);
    else setNotice(`${month} 已鎖定`);
  }

  const latestRun = runs[0] ?? null;
  const report = latestRun?.report ?? null;
  // Opus 驗收：job 行緊嗰陣唔俾再上載（會開新版本／改名單，job 讀到一半
  // 嘅資料），進度區有提示。
  const jobRunning = !!latestRun && latestRun.status === "running" && !latestRun.stalled;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader kicker="財務" title="一鍵全月結算" subtitle="上載更表 → 撳一鍵 → 睇報告 → 鎖定本月" />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <section className="rounded-lg border border-zk-border bg-white p-4">
        <Field label="月份">
          <input type="month" data-testid="month-close-month-input" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm" />
        </Field>
      </section>

      <section className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-sm font-semibold text-zk-text">① 上載</div>
        {jobRunning && <div className="mb-2 text-[12.5px] text-orange-700">一鍵結算執行緊——完成之前唔可以再上載</div>}
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[12.5px] text-zk-muted">更表 xlsx（可以一次揀多檔，逐盤一檔）</label>
            <input type="file" multiple accept=".xlsx" data-testid="month-close-roster-file-input" onChange={(e) => setRosterFiles(e.target.files)} className="mt-1 text-sm" />
            <Button className="mt-2" onClick={uploadRosters} disabled={busy || jobRunning || !rosterFiles || rosterFiles.length === 0}>
              上載更表（{rosterFiles?.length ?? 0} 檔）
            </Button>
          </div>
          <div>
            <label className="block text-[12.5px] text-zk-muted">U Team 名單（新散工建檔用）</label>
            <input type="file" accept=".xlsx" data-testid="month-close-staff-list-file-input" onChange={(e) => setStaffListFile(e.target.files?.[0] ?? null)} className="mt-1 text-sm" />
            <Button className="mt-2" onClick={uploadStaffList} disabled={busy || jobRunning || !staffListFile}>
              上載名單
            </Button>
          </div>
          <div>
            <label className="block text-[12.5px] text-zk-muted">Postorder 總表——過渡對照（可選）</label>
            <input type="file" multiple accept=".xlsm,.xlsx,.csv" data-testid="month-close-postorder-file-input" onChange={(e) => setPostorderFiles(Array.from(e.target.files ?? []))} className="mt-1 text-sm" />
            <div className="mt-1 text-[11.5px] text-zk-faint">
              §20.5：系統本身已經係總表，Postorder 純粹俾 8、9 月過渡對照用——以後淨係長工崗位盤／介紹雞頭要以系統資料為準；.xlsm 一個檔；或者 CSV：PostOrder.csv（可另加 longterm-pairs.csv 或 Roster.csv）
            </div>
            <Button className="mt-2" onClick={uploadPostorder} disabled={busy || jobRunning || postorderFiles.length === 0}>
              上載總表
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-sm font-semibold text-zk-text">② 一鍵結算</div>
        <Button variant="primary" onClick={startOneClick} disabled={busy || (!!latestRun && latestRun.status === "running" && !latestRun.stalled)}>
          一鍵結算 {month}
        </Button>
        {latestRun?.status === "running" && !latestRun.stalled && <span className="ml-2 text-[12.5px] text-zk-muted">執行緊……（可以熄屏，返嚟會接住）</span>}
      </section>

      {latestRun && (
        <section className="rounded-lg border border-zk-border bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-zk-text">③ 進度</div>
            {(latestRun.stalled || latestRun.status === "failed") && (
              <Button variant="dark" onClick={() => rerun(latestRun.id)} disabled={busy}>
                重新執行
              </Button>
            )}
          </div>
          {latestRun.stalled && <Banner kind="error" message="呢個 run 卡住咗（超過 15 分鐘冇進度）——撳「重新執行」安全（冪等，唔會重複計）" />}
          {latestRun.error_message && <Banner kind="error" message={latestRun.error_message} />}
          <div className="flex flex-col gap-2">
            {latestRun.steps.map((s) => (
              <div key={s.key} className="rounded border border-zk-border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-medium text-zk-text">{s.label}</div>
                  {stepPill(s.status)}
                </div>
                {Object.keys(s.numbers).length > 0 && (
                  <div className="mt-1 text-[11.5px] text-zk-muted">
                    {Object.entries(s.numbers)
                      .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join("　")}
                  </div>
                )}
                {s.warnings.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11.5px] text-orange-700">
                    {s.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {s.needs_human.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11.5px] text-red-700">
                    {s.needs_human.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {report && (
        <section className="flex flex-col gap-4 rounded-lg border border-zk-border bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-zk-text">④ 報告（{report.month}）</div>
            {/* §20.4 Phase 4：系統輸出 Postorder 格式總表 Excel——月結鎖定
                後仍然可以下載（老闆唔再手做總表）。同頁下載（唔開新
                tab）：Content-Disposition: attachment 已經令瀏覽器當檔案
                下載處理，跟 longterm-payroll 頁 autopay 下載掣同一個
                pattern。 */}
            <a href={`/api/reports/postorder/${report.month}`}>
              <Button variant="secondary">下載總表 Excel（Postorder 格式）</Button>
            </a>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">總收入（月結總表）</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.revenue)}</div>
            </div>
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">{report.totals.cost_basis === "combined" ? "總成本（合併：更次＋長工 Autopay＋介紹費）" : "總成本（毛利表）"}</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.cost)}</div>
            </div>
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">{report.totals.cost_basis === "combined" ? "毛利（合併口徑）" : "毛利"}</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.gross_margin)}</div>
            </div>
          </div>
          {report.totals.margin_revenue !== undefined && (
            <div className="text-[11.5px] text-zk-faint">
              成本／毛利嘅營業額跟「毛利即時表」口徑（{fmtMoney(report.totals.margin_revenue)}，唔計月結以外收入）。
              {report.totals.cost_basis === "combined"
                ? `總成本用合併口徑：長工人工用「長工糧」真實 Autopay（唔再用按更數估算）、MPF 僱主另列唔計入。「毛利即時表」頁嘅成本仲係舊估算口徑（${fmtMoney(report.totals.legacy_cost ?? 0)}，毛利 ${fmtMoney(report.totals.legacy_margin ?? 0)}），兩個數唔同係正常。`
                : "總成本係毛利表口徑（長工月薪按更數估算分攤）。"}
            </div>
          )}
          {report.longterm_payroll && (
            <div>
              <div className="mb-1 text-[13px] font-medium text-zk-text">長工糧（{report.longterm_payroll.guard_count} 人，詳細睇「長工糧」頁）</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">Gross</div>
                  <div className="text-lg font-bold">{fmtMoney(report.longterm_payroll.gross_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">Autopay（實際過數）</div>
                  <div className="text-lg font-bold">{fmtMoney(report.longterm_payroll.autopay_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">MPF 僱員</div>
                  <div className="text-lg font-bold">{fmtMoney(report.longterm_payroll.mpf_ee_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">MPF 僱主</div>
                  <div className="text-lg font-bold">{fmtMoney(report.longterm_payroll.mpf_er_total)}</div>
                </div>
              </div>
            </div>
          )}
          <Banner kind="info" message={report.longterm_payroll_note} />

          {report.auto && <AutoSummaryCard auto={report.auto} busy={busy} onUndo={() => latestRun && undoAuto(latestRun.id)} onOpenTriage={() => setTriageOpen(report.auto?.triage_session_id ?? null)} />}

          {report.combined_cost_summary && (
            <div>
              <div className="mb-1 text-[13px] font-medium text-zk-text">合併成本（§16.2 口徑，2026-08 起）</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">更次成本</div>
                  <div className="text-lg font-bold">{fmtMoney(report.combined_cost_summary.per_shift_cost_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">長工 Autopay</div>
                  <div className="text-lg font-bold">{fmtMoney(report.combined_cost_summary.longterm_autopay_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">介紹費</div>
                  <div className="text-lg font-bold">{fmtMoney(report.combined_cost_summary.referral_fee_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">合計</div>
                  <div className="text-lg font-bold">{fmtMoney(report.combined_cost_summary.combined_cost_total)}</div>
                </div>
                <div className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">MPF 僱主（另列）</div>
                  <div className="text-lg font-bold">{fmtMoney(report.combined_cost_summary.mpf_er_total)}</div>
                </div>
              </div>
              <div className="mt-1 text-[11.5px] text-zk-faint">
                「更次成本」＝散工更×出街價（原本嘅成本欄）。MPF 僱主唔計入「合計」（§16.2：MPF 落預算表第二層，唔喺第一層成本）。
                {report.combined_cost_summary.visa_passthrough_autopay_excluded
                  ? ` 長工 Autopay 已剔走簽證形式長工 ${fmtMoney(report.combined_cost_summary.visa_passthrough_autopay_excluded)}（雞頭結算扣返，唔係公司成本；糧單照出）。`
                  : ""}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1 text-[13px] font-medium text-zk-text">逐雞頭應付</div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(3) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>雞頭</th>
                    <th className={tableCls.thNum}>更數</th>
                    <th className={tableCls.thNum}>應付</th>
                  </tr>
                </thead>
                <tbody>
                  {report.payroll_by_broker.map((b) => (
                    <tr key={b.broker_code} className={tableCls.rowHover}>
                      <td className={tableCls.td}>
                        {b.broker_code}（{b.broker_name}）
                      </td>
                      <td className={tableCls.tdNum}>{b.shifts}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(b.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="mb-1 text-[13px] font-medium text-zk-text">逐盤收入</div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(3) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>盤</th>
                    <th className={tableCls.thNum}>更數</th>
                    <th className={tableCls.thNum}>收入</th>
                  </tr>
                </thead>
                <tbody>
                  {report.site_revenue.map((s) => (
                    <tr key={s.site_id} className={tableCls.rowHover}>
                      <td className={tableCls.td}>{s.site_name}</td>
                      <td className={tableCls.tdNum}>{s.shifts}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">介紹費（{report.referral_fee.count} 項）</div>
              <div className="text-lg font-bold">{fmtMoney(report.referral_fee.total)}</div>
            </div>
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">未定價</div>
              <div className="text-lg font-bold">{report.unpriced.count}</div>
              <div className="text-[11px] text-zk-muted">
                收客 {report.unpriced.client_count}／出街 {report.unpriced.payout_count}／冇結算單位 {report.unpriced.no_settlement_count}／OT {report.unpriced.ot_unpriced_count}
              </div>
              {report.unpriced.count > 0 && (
                <div className="mt-1 text-[11px] text-orange-700" data-testid="unpriced-gap">
                  未定價更數唔當 0 成本：上面成本／毛利未包呢 {report.unpriced.count} 更。
                  {report.unpriced.gap && (report.unpriced.gap.client_gap_estimate !== null || report.unpriced.gap.payout_gap_estimate !== null)
                    ? `估算缺口（按同盤同更種最近已知價，只作提示）：收入約 ${report.unpriced.gap.client_gap_estimate !== null ? fmtMoney(report.unpriced.gap.client_gap_estimate) : "—"}／成本約 ${report.unpriced.gap.payout_gap_estimate !== null ? fmtMoney(report.unpriced.gap.payout_gap_estimate) : "—"}${report.unpriced.gap.no_reference_records > 0 ? `；另有 ${report.unpriced.gap.no_reference_records} 更冇任何參考價` : ""}。`
                    : "冇參考價可以估算。"}
                </div>
              )}
            </div>
          </div>

          {report.postorder_compare && (
            <div className="rounded border border-zk-border p-3">
              <div className="text-[13px] font-medium text-zk-text">對照（Postorder，過渡對照，可選）</div>
              <div className="mt-1 text-[12.5px] text-zk-muted">
                介紹費：總表快取 {report.postorder_compare.referral_excel_total !== null ? fmtMoney(report.postorder_compare.referral_excel_total) : "（總表冇提供）"} vs 系統{" "}
                {fmtMoney(report.postorder_compare.referral_system_total)}
                {report.postorder_compare.referral_diff !== null && `（差額 ${fmtMoney(report.postorder_compare.referral_diff)}）`}
              </div>
              <div className="mt-1 text-[12px] text-zk-faint">{report.postorder_compare.note}</div>
            </div>
          )}

          {report.needs_human.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-3">
              <div className="text-[13px] font-medium text-red-800">要人決定（已按保守預設處理，可自行覆核）</div>
              <ul className="mt-1 list-disc pl-4 text-[12.5px] text-red-700">
                {report.needs_human.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded border border-zk-border p-3">
            <div className="mb-2 text-[13px] font-medium text-zk-text">⑥ 鎖定本月</div>
            {/* WP-AI-OPS §28.3：鎖月前體檢（只提示，唔擋鎖月）。 */}
            <div className="mb-3">
              <MonthHealthCard month={report.month} />
            </div>
            {report.lock_precondition.current_month_already_locked ? (
              <Pill variant="warning">已鎖定</Pill>
            ) : report.lock_precondition.ready_to_lock ? (
              <Button variant="dark" onClick={lockMonth} disabled={busy}>
                鎖定 {month}
              </Button>
            ) : (
              <div className="text-[12.5px] text-zk-muted">
                前置未齊，未可以鎖：
                {report.lock_precondition.missing_upload_sites.length > 0 && <div>未上載：{report.lock_precondition.missing_upload_sites.join("、")}</div>}
                {report.lock_precondition.unconfirmed_upload_sites.length > 0 && <div>未對數完成：{report.lock_precondition.unconfirmed_upload_sites.join("、")}</div>}
                {(report.lock_precondition.unpriced_count ?? 0) > 0 && <div>仲有 {report.lock_precondition.unpriced_count} 更未定價（見上面「要人決定」）</div>}
              </div>
            )}
          </div>
        </section>
      )}

      {triageOpen && (
        <MonthCloseTriageDialog
          sessionId={triageOpen}
          onClose={() => {
            setTriageOpen(null);
            void loadRuns();
          }}
          onChanged={() => void loadRuns()}
        />
      )}

      <section className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-2 text-sm font-semibold text-zk-text">⑦ 歷史 runs</div>
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>開始時間</th>
                <th className={tableCls.th}>狀態</th>
                <th className={tableCls.th}>而家步驟</th>
                <th className={tableCls.th}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={tableCls.rowHover}>
                  <td className={tableCls.td}>{fmtDateTime(r.started_at)}</td>
                  <td className={tableCls.td}>
                    {r.stalled ? <Pill variant="danger">卡住</Pill> : r.status === "done" ? <Pill variant="success">完成</Pill> : r.status === "failed" ? <Pill variant="danger">失敗</Pill> : <Pill variant="shift">執行緊</Pill>}
                  </td>
                  <td className={tableCls.td}>{r.current_step ?? "-"}</td>
                  <td className={tableCls.td}>
                    {(r.stalled || r.status === "failed") && (
                      <Button onClick={() => rerun(r.id)} disabled={busy}>
                        重新執行
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
