"use client";
// WP-ONE-CLICK Phase 1（§20）＋ WP-MC-UI（§32，Claude Design 第二批 handoff 1a／1e）：
// 流程不變 ① 上載 → ② 一鍵結算 → ③ 進度 → ④ 報告 → ⑤ 鎖定；API 呼叫同改版前一模一樣，
// 淨係版面重排。示意數據一律由 API 回傳砌出，冇數據就空狀態。
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { apiGet, apiPost, apiUpload } from "@/lib/ui/api-client";
import { currentMonthStr, addMonthsStr } from "@/lib/ui/format";
import { MonthCloseTriageDialog } from "@/components/MonthCloseTriageDialog";
import type { RunDTO } from "@/components/month-close/types";
import { UNDO_NOTE, shortHuman, needsHumanCount, deriveStages, deriveUploads, groupReview, stepByKey } from "@/components/month-close/derive";
import { peekUnsent } from "@/components/month-close/unsent";
import { StageBar } from "./StageBar";
import { UploadSection } from "./UploadSection";
import { RunSection } from "./RunSection";
import { ProgressSection } from "./ProgressSection";
import { ReportSection } from "./ReportSection";
import { LockSection } from "./LockSection";
import { RightRail } from "./RightRail";
import { HistorySection } from "./HistorySection";

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
  const [facts, setFacts] = useState({ sessionRoster: 0, sessionStaffList: false, sessionPostorder: false });
  const [lockedNow, setLockedNow] = useState(false);
  const [health, setHealth] = useState<{ critical: number; warn: number; info: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [unsentMsg, setUnsentMsg] = useState<string | null>(null);
  const reportUnsent = () => {
    const un = peekUnsent();
    setUnsentMsg(un.length > 0 ? `有 ${un.length} 題未送出，請重新答：${un.map((x) => shortHuman(x.title)).join("、")}` : null);
  };

  async function loadRuns() {
    const res = await apiGet<{ runs: RunDTO[] }>(`/api/month-close/one-click?month=${month}`);
    if (res.ok) setRuns(res.data.runs);
  }

  // 上次對話框關閉／離開時有題送出失敗（記喺 sessionStorage）→ 提示重新答。
  useEffect(() => {
    reportUnsent();
  }, []);

  useEffect(() => {
    setFacts({ sessionRoster: 0, sessionStaffList: false, sessionPostorder: false });
    setLockedNow(false);
    setHealth(null);
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

  // P3-0.6（B-10）：unmount 即停 polling（唔再打 API／setState）。
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  async function pollUntilDone(runId: string) {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (unmountedRef.current) break;
      const res = await apiGet<{ runs: RunDTO[] }>(`/api/month-close/one-click?month=${month}`);
      if (unmountedRef.current) break;
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
    if (ok > 0) setFacts((f) => ({ ...f, sessionRoster: f.sessionRoster + ok }));
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
    else {
      setNotice("U Team 名單已上載");
      setFacts((f) => ({ ...f, sessionStaffList: true }));
    }
    setStaffListFile(null);
  }

  // Opus 驗收：正式站操作員淨係上載得 CSV（讀唔到 .xlsm binary）——按副檔名／檔名分流到
  // `POST /api/guard-fix/postorder` 現有嘅四個入口（xlsm／roster_csv＋postorder_csv／
  // longterm_pairs_csv／淨 postorder_csv），同「保安員配對修復」頁一致。
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
    else {
      setNotice("Postorder 總表已上載（可選對照用）");
      setFacts((f) => ({ ...f, sessionPostorder: true }));
    }
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
    if (!window.confirm(`還原呢次一鍵結算所有「自動」改動？\n\n${UNDO_NOTE}`)) return;
    setBusy(true);
    setError(null);
    const res = await apiPost<{ undone: Record<string, number>; skipped: Array<{ kind: string; reason: string }>; already_undone: boolean; still_using_voided_card_prices?: number }>(`/api/month-close/one-click/${runId}/undo-auto`);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const total = Object.values(res.data.undone).reduce((a, b) => a + b, 0);
    setNotice(res.data.already_undone ? "之前已經還原過" : `已還原 ${total} 項自動改動${res.data.skipped.length ? `；${res.data.skipped.length} 項保留（${res.data.skipped.map((x) => x.reason).slice(0, 2).join("；")}）` : ""}${res.data.still_using_voided_card_prices ? `；注意：${res.data.still_using_voided_card_prices} 更價錢同已作廢卡相同但冇自動定價紀錄，可能係人手輸入，請檢查` : ""}`);
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
    else {
      setNotice(`${month} 已鎖定`);
      setLockedNow(true);
    }
  }

  const latestRun = runs[0] ?? null;
  const report = latestRun?.report ?? null;
  // Opus 驗收：job 行緊嗰陣唔俾再上載（會開新版本／改名單，job 讀到一半嘅資料）。
  const jobRunning = !!latestRun && latestRun.status === "running" && !latestRun.stalled;
  const locked = lockedNow || report?.lock_precondition.current_month_already_locked === true || stepByKey(latestRun, "precheck")?.numbers.currentMonthLocked === true;

  const uploads = useMemo(() => deriveUploads(latestRun, facts, report), [latestRun, facts, report]);
  const stages = useMemo(() => deriveStages({ run: latestRun, report, uploads, locked }), [latestRun, report, uploads, locked]);
  const groups = useMemo(() => groupReview(report?.auto?.review), [report]);
  const sessionId = report?.auto?.triage_session_id ?? null;
  const openTriage = () => {
    if (sessionId) setTriageOpen(sessionId);
  };
  const stepMonth = (d: number) => setMonth(addMonthsStr(month, d));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        kicker="財務"
        title="一鍵全月結算"
        actions={
          <>
            <div className="flex items-center gap-1 rounded-md border border-zk-border bg-white px-1.5 py-0.5 text-[13px] text-zk-text-secondary">
              <button type="button" aria-label="上一個月" className="px-1.5 text-zk-faint hover:text-zk-text" onClick={() => stepMonth(-1)}>
                ‹
              </button>
              <input type="month" data-testid="month-close-month-input" aria-label="月份" value={month} onChange={(e) => setMonth(e.target.value)} className="w-[120px] bg-transparent py-0.5 text-[13px] outline-none" />
              <button type="button" aria-label="下一個月" className="px-1.5 text-zk-faint hover:text-zk-text" onClick={() => stepMonth(1)}>
                ›
              </button>
            </div>
            {/* §20.4 Phase 4：系統輸出 Postorder 格式總表 Excel——月結鎖定後仍然可以下載。同頁下載（Content-Disposition: attachment）。 */}
            {report && (
              <a href={`/api/reports/postorder/${report.month}`}>
                <Button variant="secondary">下載總表 Excel（Postorder 格式）</Button>
              </a>
            )}
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      <Banner kind="error" message={unsentMsg} />
      {locked && <div className="rounded border border-zk-warning-border bg-zk-warning-bg px-3 py-2 text-[12.5px] text-zk-warning-dark">{month} 已鎖定，成頁只讀；要改要搵有「月結鎖定解鎖」權限嘅同事。</div>}

      <StageBar stages={stages} />

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-1">
          <UploadSection
            rows={uploads}
            month={month}
            busy={busy}
            disabled={jobRunning || locked}
            jobRunning={jobRunning}
            rosterFiles={rosterFiles}
            staffListFile={staffListFile}
            postorderFiles={postorderFiles}
            onRosterFiles={setRosterFiles}
            onStaffListFile={setStaffListFile}
            onPostorderFiles={setPostorderFiles}
            onUploadRosters={uploadRosters}
            onUploadStaffList={uploadStaffList}
            onUploadPostorder={uploadPostorder}
          />
          <RunSection month={month} run={latestRun} busy={busy} locked={locked} havePostorder={uploads.find((u) => u.key === "postorder")?.have === true} onStart={startOneClick} />
          {latestRun && <ProgressSection run={latestRun} busy={busy} locked={locked} onRerun={() => rerun(latestRun.id)} />}
          {report && (
            <>
              <ReportSection
                run={latestRun!}
                report={report}
                busy={busy}
                locked={locked}
                groups={groups}
                onUndo={() => latestRun && undoAuto(latestRun.id)}
                onOpenTriage={openTriage}
              />
              <LockSection
                report={report}
                month={month}
                busy={busy}
                locked={locked}
                groups={groups}
                onLock={lockMonth}
                onOpenTriage={openTriage}
                onHealth={setHealth}
              />
            </>
          )}
          <HistorySection runs={runs} busy={busy} open={showHistory} onToggle={() => setShowHistory((v) => !v)} onRerun={rerun} />
        </div>
        {report && (
          <div className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-4">
            <RightRail needsHuman={needsHumanCount(latestRun)} report={report} month={month} busy={busy} locked={locked} health={health} onOpenTriage={openTriage} onLock={lockMonth} onUndo={() => latestRun && undoAuto(latestRun.id)} />
          </div>
        )}
      </div>

      {triageOpen && (
        <MonthCloseTriageDialog
          sessionId={triageOpen}
          month={month}
          onClose={() => {
            setTriageOpen(null);
            reportUnsent(); // 仲有未送出嘅題先提示；全部送出就清走
            void loadRuns();
          }}
          onChanged={() => {
            reportUnsent();
            void loadRuns();
          }}
        />
      )}
    </div>
  );
}
