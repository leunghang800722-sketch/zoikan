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
  totals: { revenue: number; cost: number; gross_margin: number };
  payroll_by_broker: Array<{ broker_code: string; broker_name: string; shifts: number; amount: number }>;
  site_revenue: Array<{ site_id: string; site_name: string; shifts: number; revenue: number }>;
  referral_fee: { total: number; count: number };
  unpriced: { count: number; payout_count: number; client_count: number; no_settlement_count: number; ot_unpriced_count: number };
  postorder_compare: { uploaded: boolean; referral_excel_total: number | null; referral_system_total: number; referral_diff: number | null; note: string } | null;
  needs_human: string[];
  lock_precondition: { current_month_already_locked: boolean; missing_upload_sites: string[]; unconfirmed_upload_sites: string[]; ready_to_lock: boolean };
  longterm_payroll_note: string;
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
  const [postorderFile, setPostorderFile] = useState<File | null>(null);
  const pollingRef = useRef<string | null>(null);

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

  async function uploadPostorder() {
    if (!postorderFile) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", postorderFile);
    fd.append("month", month);
    const res = await apiUpload(`/api/guard-fix/postorder`, fd);
    setBusy(false);
    if (!res.ok) setError(res.message);
    else setNotice("Postorder 總表已上載（可選對照用）");
    setPostorderFile(null);
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
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[12.5px] text-zk-muted">更表 xlsx（可以一次揀多檔，逐盤一檔）</label>
            <input type="file" multiple accept=".xlsx" data-testid="month-close-roster-file-input" onChange={(e) => setRosterFiles(e.target.files)} className="mt-1 text-sm" />
            <Button className="mt-2" onClick={uploadRosters} disabled={busy || !rosterFiles || rosterFiles.length === 0}>
              上載更表（{rosterFiles?.length ?? 0} 檔）
            </Button>
          </div>
          <div>
            <label className="block text-[12.5px] text-zk-muted">U Team 名單（新散工建檔用）</label>
            <input type="file" accept=".xlsx" data-testid="month-close-staff-list-file-input" onChange={(e) => setStaffListFile(e.target.files?.[0] ?? null)} className="mt-1 text-sm" />
            <Button className="mt-2" onClick={uploadStaffList} disabled={busy || !staffListFile}>
              上載名單
            </Button>
          </div>
          <div>
            <label className="block text-[12.5px] text-zk-muted">Postorder 總表（可選，只做過渡對照）</label>
            <input type="file" accept=".xlsm,.xlsx,.csv" data-testid="month-close-postorder-file-input" onChange={(e) => setPostorderFile(e.target.files?.[0] ?? null)} className="mt-1 text-sm" />
            <Button className="mt-2" onClick={uploadPostorder} disabled={busy || !postorderFile}>
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
          <div className="text-sm font-semibold text-zk-text">④ 報告（{report.month}）</div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">總收入</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.revenue)}</div>
            </div>
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">總成本</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.cost)}</div>
            </div>
            <div className="rounded border border-zk-border p-3">
              <div className="text-[11.5px] text-zk-muted">毛利</div>
              <div className="text-lg font-bold">{fmtMoney(report.totals.gross_margin)}</div>
            </div>
          </div>
          <Banner kind="info" message={report.longterm_payroll_note} />

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
            </div>
          </div>

          {report.postorder_compare && (
            <div className="rounded border border-zk-border p-3">
              <div className="text-[13px] font-medium text-zk-text">對照（Postorder，可選）</div>
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
              </div>
            )}
          </div>
        </section>
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
