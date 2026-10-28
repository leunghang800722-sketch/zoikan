"use client";
// HIST-2：更表上載頁揀 2026-07 前月份（1–6 月）時出現嘅導航卡——
//   未標歷史 → 「呢個月係 2026-07 前月份，先標做歷史月份」一撳 POST /api/month-closes { historical: true }；
//   已標歷史 → 「歷史月份：一鍵導入」掣（POST /api/month-close/historical-import，背景跑，poll 顯示進度＋報告）。
// 報告只有盤名＋數字（API 保證冇姓名／工號／電話）。權限由 API 把關（冇權限會見到 403 訊息）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";

const HIST_MAX = "2026-07";

interface MonthCloseRow {
  id: string;
  month: string;
  historical: boolean;
  locked_at: string | null;
}
interface StepDTO {
  key: string;
  label: string;
  status: string;
}
interface SiteRow {
  site_label: string;
  cells: number;
  written: number;
  unresolved: number;
  roster_only: number;
  unresolved_by_reason: Record<string, number>;
}
interface PostorderRow {
  label: string;
  roster_cells: number;
  postorder_cells: number | null;
  diff: number | null;
}
interface ReportDTO {
  month: string;
  created: { sites: number; shift_types: number; guards: number; site_aliases: number };
  totals: { uploads: number; parse_failed_uploads: number; cells: number; written: number; unresolved: number; unresolved_by_reason: Record<string, number> };
  per_site: SiteRow[];
  postorder: { uploaded: boolean; per_site?: PostorderRow[]; unmatched_postorder?: Array<{ property: string; cells: number }>; totals?: { roster_cells: number; postorder_cells: number; matched_sites: number; unmatched_sites: number; sites_with_diff: number } };
  needs_human: string[];
}
interface RunDTO {
  id: string;
  month: string;
  status: "running" | "done" | "failed";
  stalled: boolean;
  current_step: string | null;
  steps: StepDTO[];
  report: ReportDTO | null;
  error_message: string | null;
}

const REASON_LABEL: Record<string, string> = {
  guard_unmatched: "保安員未配對",
  shift_type_unmatched: "更別／更種未配對",
  date_outside_month: "日期唔係本月",
  site_unresolved: "盤／子盤未定",
  broker_code_unmatched: "雞頭碼對唔到",
  leave_shift_type_unknown: "請假推斷唔到更別",
  other: "其他",
};

function isHistoricalCandidateMonth(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && month < HIST_MAX;
}

export default function HistoricalMonthPanel({ month, onImported }: { month: string; onImported?: () => void }) {
  const [row, setRow] = useState<MonthCloseRow | null | undefined>(undefined); // undefined＝載入中
  const [run, setRun] = useState<RunDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unmounted = useRef(false);
  const pollingFor = useRef<string | null>(null);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const loadRow = useCallback(async () => {
    const res = await apiGet<ApiListResult<MonthCloseRow>>(`/api/month-closes?month=${month}`);
    if (unmounted.current) return;
    if (!res.ok) {
      setRow(null);
      return;
    }
    setRow(res.data.rows[0] ?? null);
  }, [month]);

  const loadRuns = useCallback(async () => {
    const res = await apiGet<{ runs: RunDTO[] }>(`/api/month-close/historical-import?month=${month}-01`);
    if (unmounted.current) return null;
    const latest = res.ok ? (res.data.runs[0] ?? null) : null;
    setRun(latest);
    return latest;
  }, [month]);

  const poll = useCallback(
    async (runId: string) => {
      if (pollingFor.current === runId) return;
      pollingFor.current = runId;
      for (let i = 0; i < 600; i++) {
        if (unmounted.current || pollingFor.current !== runId) return;
        const r = await loadRuns();
        if (r && r.id === runId && (r.status !== "running" || r.stalled)) {
          pollingFor.current = null;
          if (r.status === "done") onImported?.();
          return;
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
      pollingFor.current = null;
    },
    [loadRuns, onImported],
  );

  useEffect(() => {
    if (!isHistoricalCandidateMonth(month)) return;
    setRow(undefined);
    setRun(null);
    setError(null);
    pollingFor.current = null;
    void (async () => {
      await loadRow();
      const latest = await loadRuns();
      if (latest && latest.status === "running" && !latest.stalled) void poll(latest.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  if (!isHistoricalCandidateMonth(month) || row === undefined) return null;

  async function markHistorical() {
    setBusy(true);
    setError(null);
    const res = await apiPost("/api/month-closes", { month, historical: true });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    await loadRow();
  }

  async function startImport() {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ run_id: string; status: string }>("/api/month-close/historical-import", { month });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    await loadRuns();
    void poll(res.data.run_id);
  }

  const running = run?.status === "running" && !run.stalled;
  return (
    <section className="rounded-lg border border-zk-border bg-white p-3 sm:p-4" data-testid="hist-month-panel">
      <Banner kind="error" message={error} />
      {!row?.historical ? (
        <div className="flex flex-wrap items-center justify-between gap-3" data-testid="hist-mark-card">
          <div>
            <div className="text-sm font-semibold text-zk-text">呢個月係 2026-07 前月份，先標做歷史月份</div>
            <p className="text-zk-sm text-zk-muted">歷史月份只用嚟上載更表、對數、落更同計假期結餘；唔跑月結／糧／鎖月。標咗之後先可以「一鍵導入」。</p>
          </div>
          <Button variant="primary" onClick={() => void markHistorical()} disabled={busy} data-testid="hist-mark-button">
            {busy ? "處理緊…" : "標做歷史月份"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-zk-text">歷史月份：一鍵導入</div>
              <p className="text-zk-sm text-zk-muted">上載晒呢個月更表（同埋 Postorder CSV）之後撳：自動建缺少嘅盤／更種、修復保安員（新人會建成「停用」）、全月對數落更，最後出報告。可以重複撳（冪等）。</p>
            </div>
            <Button variant="primary" onClick={() => void startImport()} disabled={busy || running} data-testid="hist-import-button">
              {running ? "導入緊…" : "一鍵導入"}
            </Button>
          </div>
          {run && <RunView run={run} />}
        </div>
      )}
    </section>
  );
}

function RunView({ run }: { run: RunDTO }) {
  const report = run.report;
  return (
    <div className="flex flex-col gap-2 text-zk-sm" data-testid="hist-run-view">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-zk-muted">
        {run.steps.map((s) => (
          <span key={s.key} className={s.status === "done" ? "text-zk-success-dark" : s.status === "failed" ? "text-zk-danger-dark" : s.status === "running" ? "font-semibold text-zk-primary-dark" : ""}>
            {s.label}：{{ pending: "等候", running: "進行中", done: "完成", failed: "失敗", skipped: "略過" }[s.status] ?? s.status}
          </span>
        ))}
      </div>
      {run.status === "failed" && <Banner kind="error" message={`導入失敗：${run.error_message ?? "未知原因"}（修正後可再撳「一鍵導入」，冪等）`} />}
      {run.stalled && <Banner kind="warning" message="上一次導入執行超過 15 分鐘冇完成（可能伺服器中途重啟）——可以再撳「一鍵導入」，安全冪等。" />}
      {report && (
        <>
          <div className="text-zk-text" data-testid="hist-report-summary">
            {report.month}：{report.totals.uploads} 個上載、{report.totals.cells} 格，已寫入 {report.totals.written} 格，未解決 {report.totals.unresolved} 格
            {Object.keys(report.totals.unresolved_by_reason).length > 0 && `（${Object.entries(report.totals.unresolved_by_reason).map(([k, v]) => `${REASON_LABEL[k] ?? k} ${v}`).join("、")}）`}。 新建盤 {report.created.sites}、更種 {report.created.shift_types}、停用保安員 {report.created.guards}、盤別名 {report.created.site_aliases}。
            {report.totals.parse_failed_uploads > 0 && <span className="text-zk-danger-dark"> {report.totals.parse_failed_uploads} 份上載解析失敗。</span>}
          </div>
          <details>
            <summary className="cursor-pointer text-zk-primary">逐盤明細（{report.per_site.length} 個盤）</summary>
            <ul className="mt-2 max-h-72 divide-y divide-zk-border overflow-y-auto rounded border border-zk-border">
              {report.per_site.map((s) => (
                <li key={s.site_label} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 break-words font-medium text-zk-text">{s.site_label}</span>
                  <span className="tabular-nums text-zk-muted">
                    {s.cells} 格・寫入 {s.written}・未解決 {s.unresolved}
                    {s.unresolved > 0 && `（${Object.entries(s.unresolved_by_reason).map(([k, v]) => `${REASON_LABEL[k] ?? k} ${v}`).join("、")}）`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {report.postorder.uploaded && report.postorder.per_site && (
            <details data-testid="hist-postorder-compare">
              <summary className="cursor-pointer text-zk-primary">
                更表 vs Postorder（Roster 分頁）逐盤格數
                {report.postorder.totals ? `（更表 ${report.postorder.totals.roster_cells}／Postorder ${report.postorder.totals.postorder_cells}，${report.postorder.totals.sites_with_diff} 個盤有差異，${report.postorder.totals.unmatched_sites} 個盤對唔到）` : ""}
              </summary>
              <ul className="mt-2 max-h-72 divide-y divide-zk-border overflow-y-auto rounded border border-zk-border">
                {report.postorder.per_site.filter((p) => p.diff !== 0).map((p) => (
                  <li key={p.label} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                    <span className="min-w-0 break-words font-medium text-zk-text">{p.label}</span>
                    <span className="tabular-nums text-zk-muted">{p.postorder_cells === null ? `更表 ${p.roster_cells}・Postorder 對唔到` : `更表 ${p.roster_cells}・Postorder ${p.postorder_cells}・差 ${p.diff}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.needs_human.length > 0 && (
            <details>
              <summary className="cursor-pointer text-zk-warning-dark">要你睇（{report.needs_human.length}）</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-zk-text">
                {report.needs_human.slice(0, 50).map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
