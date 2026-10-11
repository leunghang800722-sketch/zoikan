"use client";
// P7.1：自動排程（老闆專用）——列 job、時間表、開關、上次結果、立即跑（試跑用）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiPatch, apiPost } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";
import { formatHkTime } from "@/components/home/HomeNotifications";

interface RunRow {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown> | null;
}
interface JobRow {
  key: string;
  label: string;
  description: string;
  default_schedule: string;
  schedule: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  recent_runs: RunRow[];
}

const STATUS_LABEL: Record<string, string> = { ok: "成功", error: "失敗", skipped: "跳過", running: "跑緊" };

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await apiGet<{ jobs: JobRow[] }>("/api/admin/jobs");
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setJobs(res.data.jobs);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(j: JobRow) {
    setBusy(j.key);
    const res = await apiPatch(`/api/admin/jobs/${j.key}`, { enabled: !j.enabled });
    setBusy(null);
    if (!res.ok) setError(res.message);
    else {
      setNotice(`${j.label}：已${j.enabled ? "停用" : "啟用"}。`);
      await load();
    }
  }
  async function saveSchedule(j: JobRow) {
    const schedule = (drafts[j.key] ?? j.schedule).trim();
    setBusy(j.key);
    const res = await apiPatch(`/api/admin/jobs/${j.key}`, { schedule });
    setBusy(null);
    if (!res.ok) setError(res.message);
    else {
      setNotice(`${j.label}：時間表已改為「${schedule}」。`);
      setDrafts((d) => {
        const { [j.key]: _omit, ...rest } = d;
        void _omit;
        return rest;
      });
      await load();
    }
  }
  async function runNow(j: JobRow) {
    setBusy(j.key);
    setError(null);
    const res = await apiPost<{ status: string; error: string | null }>(`/api/admin/jobs/${j.key}/run-now`, {});
    setBusy(null);
    if (!res.ok) setError(res.message);
    else setNotice(`${j.label}：試跑${STATUS_LABEL[res.data.status] ?? res.data.status}${res.data.error ? `（${res.data.error}）` : ""}。`);
    await load();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="jobs-page">
      <PageHeader kicker={kickerFor("/settings/jobs")} title="自動排程" subtitle="每月重複嘅嘢由系統做。時間按香港時間，5 欄 cron（分 時 日 月 星期）。「立即跑」用嚟試跑，唔影響下次排程時間。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {jobs === null ? (
        <div className="text-zk-base text-zk-muted">載入緊…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((j) => (
            <section key={j.key} data-testid={`job-${j.key}`} className="rounded-[10px] border border-zk-border bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-zk-md font-semibold text-zk-text">{j.label}</h2>
                <Pill variant={j.enabled ? "success" : "neutral"}>{j.enabled ? "啟用中" : "已停用"}</Pill>
                {j.last_status && <Pill variant={j.last_status === "error" ? "danger" : "neutral"}>上次：{STATUS_LABEL[j.last_status] ?? j.last_status}</Pill>}
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={busy === j.key} onClick={() => runNow(j)} data-testid={`job-${j.key}-run-now`}>
                    {busy === j.key ? "處理緊…" : "立即跑"}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy === j.key} onClick={() => toggle(j)} data-testid={`job-${j.key}-toggle`}>
                    {j.enabled ? "停用" : "啟用"}
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-zk-sm text-zk-muted">{j.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-zk-sm text-zk-text-secondary">
                <label className="flex items-center gap-1.5">
                  時間表
                  <input
                    value={drafts[j.key] ?? j.schedule}
                    onChange={(e) => setDrafts((d) => ({ ...d, [j.key]: e.target.value }))}
                    aria-label={`${j.label} 時間表`}
                    className="w-40 rounded-md border border-zk-border px-2 py-1 font-mono text-zk-sm"
                    data-testid={`job-${j.key}-schedule`}
                  />
                </label>
                {drafts[j.key] !== undefined && drafts[j.key] !== j.schedule && (
                  <Button size="sm" variant="primary" disabled={busy === j.key} onClick={() => saveSchedule(j)}>
                    儲存
                  </Button>
                )}
                <span className="text-zk-muted">預設 {j.default_schedule}</span>
                <span className="ml-auto text-zk-muted">下次：{j.next_run_at ? formatHkTime(j.next_run_at) : "—"}　上次：{j.last_run_at ? formatHkTime(j.last_run_at) : "—"}</span>
              </div>
              {j.last_error && <p className="mt-1 text-zk-sm text-zk-danger-dark">上次錯誤：{j.last_error}</p>}
              {j.recent_runs.length > 0 && (
                <details className="mt-2 text-zk-sm">
                  <summary className="cursor-pointer text-zk-muted">最近 {j.recent_runs.length} 次紀錄</summary>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {j.recent_runs.map((r) => (
                      <li key={r.id} className="flex flex-wrap gap-x-3 text-zk-text-secondary">
                        <span>{formatHkTime(r.started_at)}</span>
                        <span>{r.trigger === "manual" ? "手動" : "排程"}</span>
                        <span>{STATUS_LABEL[r.status] ?? r.status}</span>
                        <span className="text-zk-muted">{r.summary ? JSON.stringify(r.summary) : ""}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
