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
import { runFromSummary, type RunDTO, type RunSummaryDTO } from "@/components/month-close/types";
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
import { kickerFor } from "@/lib/nav/schema";
import { MonthPicker, useMonthState } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function MonthCloseOneClickPage({ isBoss, canUnlock }: { isBoss: boolean; canUnlock: boolean }) {
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
  const [month, setMonth, monthReady] = useMonthState(addMonthsStr(currentMonthStr(), -1));
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
  // null＝跟最新 run 報告；鎖／解鎖之後蓋過（run 報告係結算當時嘅快照）。
  const [lockedOverride, setLockedOverride] = useState<boolean | null>(null);
  // P3-4.0：鎖定狀態以 month_closes 記錄為準（`GET /api/month-closes?month=`），唔依賴有冇一鍵結算 run（7、8 月係舊月結工作台鎖嘅）。
  const [mcRecord, setMcRecord] = useState<{ id: string; locked_at: string | null } | null>(null);
  const [health, setHealth] = useState<{ critical: number; warn: number; info: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [unsentMsg, setUnsentMsg] = useState<string | null>(null);
  const reportUnsent = () => {
    const un = peekUnsent();
    setUnsentMsg(un.length > 0 ? `有 ${un.length} 題未送出，請重新答：${un.map((x) => shortHuman(x.title)).join("、")}` : null);
  };

  // P3-1.6：列表只拉摘要（~幾 KB），最新一個 run 再拉單一 route 攞全份 steps／report。
  async function loadRuns() {
    const res = await apiGet<{ runs: RunSummaryDTO[] }>(`/api/month-close/one-click?month=${month}`);
    if (!res.ok) return;
    const list = res.data.runs.map(runFromSummary);
    const latest = list[0];
    if (latest) {
      const one = await apiGet<{ run: RunDTO }>(`/api/month-close/one-click/${latest.id}`);
      if (unmountedRef.current) return;
      if (one.ok) list[0] = one.data.run;
    }
    setRuns(list);
  }

  // 快速換月 race：response 回嚟時月份已經變咗就唔 set（用 ref 對返 request 月份）。
  const monthRef = useRef(month);
  useEffect(() => {
    monthRef.current = month;
  }, [month]);
  async function loadMonthClose() {
    const reqMonth = month;
    const res = await apiGet<{ rows: Array<{ id: string; locked_at: string | null }> }>(`/api/month-closes?month=${reqMonth}`);
    if (unmountedRef.current || monthRef.current !== reqMonth) return;
    setMcRecord(res.ok ? (res.data.rows[0] ?? null) : null);
  }

  // 上次對話框關閉／離開時有題送出失敗（記喺 sessionStorage）→ 提示重新答。
  useEffect(() => {
    reportUnsent();
  }, []);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    setFacts({ sessionRoster: 0, sessionStaffList: false, sessionPostorder: false });
    setLockedOverride(null);
    setHealth(null);
    setMcRecord(null);
    loadRuns();
    void loadMonthClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, monthReady]);

  useEffect(() => {
    const running = runs.find((r) => r.status === "running" && !r.stalled);
    if (running && pollingRef.current !== running.id) {
      pollingRef.current = running.id;
      void pollUntilDone(running.id);
    }
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
      // P3-1.6：polling 只拉呢個 running run 嘅單一 route（~幾 KB），唔再每 5 秒拉 20 個 run 全份報告。
      const res = await apiGet<{ run: RunDTO }>(`/api/month-close/one-click/${runId}`);
      if (unmountedRef.current) break;
      if (!res.ok) continue;
      const cur = res.data.run;
      setRuns((prev) => prev.map((r) => (r.id === cur.id ? cur : r)));
      if (cur.status !== "running" || cur.stalled) break;
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
    if (!(await askConfirm({ message: `還原呢次一鍵結算所有「自動」改動？\n\n${UNDO_NOTE}`, confirmLabel: "還原", tone: "danger" }))) return;
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

  // §6.3 對數有紅色差異（generate 回應 `reconciliation.has_diff`）：lock API 要 `override_reason`（同「強制鎖定」係兩樣嘢：
  // force 繞過更表上載／對數未齊；override_reason 係紅色差異嘅原因）。有差異但未填原因就唔打 lock，出原因輸入（LockSection＋右欄）。
  const [diffReason, setDiffReason] = useState("");
  const [needDiffReason, setNeedDiffReason] = useState(false);
  async function lockMonth(force?: { reason: string }) {
    setBusy(true);
    setError(null);
    const gen = await apiPost<{ month_close: { id: string }; reconciliation?: { has_diff?: boolean } }>(`/api/month-closes/${month}/generate`);
    if (!gen.ok) {
      setBusy(false);
      setError(gen.message);
      return;
    }
    const hasDiff = gen.data.reconciliation?.has_diff === true;
    if (hasDiff && !diffReason.trim()) {
      setBusy(false);
      setNeedDiffReason(true);
      setError("§6.3 對數規則有紅色差異，鎖定要填「override 原因」（鎖定區／右欄），填咗再撳鎖定。");
      return;
    }
    // 只有差異：override_reason＝差異原因；只有強制：＝強制原因；兩樣都有：合併（lock API 淨係得一個 override_reason 欄）。
    const reason = hasDiff && force ? `${diffReason.trim()}；強制鎖定：${force.reason}` : hasDiff ? diffReason.trim() : (force?.reason ?? "");
    const body: Record<string, unknown> = {};
    if (force) body.force = true;
    if (reason) body.override_reason = reason;
    const res = await apiPost(`/api/month-closes/${gen.data.month_close.id}/lock`, body);
    setBusy(false);
    if (!res.ok) setError(res.message);
    else {
      setNotice(`${month} 已鎖定`);
      setLockedOverride(true);
      void loadMonthClose();
      setNeedDiffReason(false);
      setDiffReason("");
    }
  }

  // P3-3.4：解鎖（只喺已鎖定時由 LockSection 出現）。API 不變：POST /api/month-closes/:id/unlock { reason }。
  async function unlockMonth(reason: string) {
    setBusy(true);
    setError(null);
    const gen = await apiPost<{ month_close: { id: string } }>(`/api/month-closes/${month}/generate`);
    if (!gen.ok) {
      setBusy(false);
      setError(gen.message);
      return;
    }
    const res = await apiPost(`/api/month-closes/${gen.data.month_close.id}/unlock`, { reason });
    setBusy(false);
    if (!res.ok) setError(res.message);
    else {
      setNotice(`${month} 已解鎖`);
      setLockedOverride(false);
      void loadMonthClose();
      await loadRuns();
    }
  }

  const latestRun = runs[0] ?? null;
  const report = latestRun?.report ?? null;
  // Opus 驗收：job 行緊嗰陣唔俾再上載（會開新版本／改名單，job 讀到一半嘅資料）。
  const jobRunning = !!latestRun && latestRun.status === "running" && !latestRun.stalled;
  const runLocked = report?.lock_precondition.current_month_already_locked === true || stepByKey(latestRun, "precheck")?.numbers.currentMonthLocked === true;
  // month_closes 有記錄就以記錄為準；冇記錄先睇 run 報告。
  const locked = lockedOverride ?? (mcRecord ? !!mcRecord.locked_at : runLocked);
  const lockedAt = mcRecord?.locked_at ?? (lockedOverride === true ? new Date().toISOString() : null);

  const uploads = useMemo(() => deriveUploads(latestRun, facts, report), [latestRun, facts, report]);
  const stages = useMemo(() => deriveStages({ run: latestRun, report, uploads, locked, lockedAt }), [latestRun, report, uploads, locked, lockedAt]);
  const groups = useMemo(() => groupReview(report?.auto?.review), [report]);
  const sessionId = report?.auto?.triage_session_id ?? null;
  const openTriage = () => {
    if (sessionId) setTriageOpen(sessionId);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 max-lg:pb-20">
      {confirmDialog}
      <PageHeader
        kicker={kickerFor("/month-close")}
        title="一鍵全月結算"
        actions={
          <>
            <MonthPicker value={month} onChange={setMonth} testId="month-close-month-input" />
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
      {locked && <div className="rounded border border-zk-warning-border bg-zk-warning-bg px-3 py-2 text-zk-sm text-zk-warning-dark">{month} 已鎖定，成頁只讀；要改要搵有「月結鎖定解鎖」權限嘅同事。</div>}

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
                onOpenTriage={openTriage}
                onChanged={() => void loadRuns()}
              />
              <LockSection
                report={report}
                lockedAt={lockedAt}
                month={month}
                busy={busy}
                locked={locked}
                groups={groups}
                onUnlock={unlockMonth}
                canUnlock={canUnlock}
                needDiffReason={needDiffReason}
                diffReason={diffReason}
                onDiffReason={setDiffReason}
                isBoss={isBoss}
                onForceLock={(reason) => lockMonth({ reason })}
                onOpenTriage={openTriage}
                onHealth={setHealth}
              />
            </>
          )}
          {!report && locked && (
            <LockSection
              report={null}
              lockedAt={lockedAt}
              month={month}
              busy={busy}
              locked={locked}
              groups={groups}
              onUnlock={unlockMonth}
              canUnlock={canUnlock}
              needDiffReason={false}
              diffReason=""
              onDiffReason={setDiffReason}
              isBoss={isBoss}
              onForceLock={() => undefined}
              onOpenTriage={openTriage}
              onHealth={setHealth}
            />
          )}
          <HistorySection runs={runs} busy={busy} open={showHistory} onToggle={() => setShowHistory((v) => !v)} onRerun={rerun} />
        </div>
        {report && (
          <div className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-4">
            <RightRail needDiffReason={needDiffReason} diffReason={diffReason} onDiffReason={setDiffReason} needsHuman={needsHumanCount(latestRun)} report={report} month={month} busy={busy} locked={locked} health={health} onOpenTriage={openTriage} onLock={() => lockMonth()} onUndo={() => latestRun && undoAuto(latestRun.id)} />
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
