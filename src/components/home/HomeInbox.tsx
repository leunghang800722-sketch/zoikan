"use client";
// P3-3.3：首頁「待辦」收件箱——以前「待處理」9 處各自計、單位亂（題／更／格／盤／項）。
// 而家一行卡，單位寫清楚：審批＝更、待答＝題、未對數＝盤、要老闆決定＝項。
// 審批、待答由 server page 傳落嚟（layout 已經查過，react cache 共用）；
// 未對數／月結進度／要老闆決定係唯讀 API，按 grants 先 fetch（冇權限就唔出該格、唔打 API）。
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { addMonthsStr, currentMonthStr } from "@/lib/ui/format";
import { useMonthState } from "@/components/ui/MonthPicker";
import type { RunSummaryDTO } from "@/components/month-close/types";

export interface HomeInboxProps {
  /** 待審批更數；null＝冇「審批」權限（唔出該格）。 */
  approvals: number | null;
  /** 待答問題數（題）；null＝冇「導入分診」權限。 */
  triage: number | null;
  canRosterUploads: boolean;
  canMonthClose: boolean;
  /** 老闆專用：保安員配對修復 view。 */
  canGuardFix: boolean;
}

interface PendingSummary {
  total: number;
  entries: { site_name: string; pending_count: number; month: string }[];
  name_only?: { total: number };
}
interface GuardFixRunsResponse {
  runs: { id: string; summary?: { needs_boss?: number } | null }[];
}

function Card({ testId, label, value, unit, note, href, tone }: { testId: string; label: string; value: React.ReactNode; unit?: string; note?: React.ReactNode; href: string; tone?: "danger" | "ok" }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex min-w-[150px] flex-1 flex-col rounded-[10px] border border-zk-border bg-white px-3.5 py-2.5 transition-colors hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary"
    >
      <div className="text-xs text-zk-muted">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`text-zk-xl leading-[1.15] font-bold ${tone === "danger" ? "text-zk-danger" : tone === "ok" ? "text-zk-success" : "text-zk-text"}`}>{value}</span>
        {unit && <span className="text-xs text-zk-muted">{unit}</span>}
      </div>
      {note && <div className="mt-0.5 truncate text-zk-xs text-zk-muted">{note}</div>}
    </Link>
  );
}

export function HomeInbox({ approvals, triage, canRosterUploads, canMonthClose, canGuardFix }: HomeInboxProps) {
  // 月結進度睇緊邊個月：同全站月份選擇器共用（URL → sessionStorage → 上個月，同一鍵結算頁預設一致）。
  const [month, , monthReady] = useMonthState(addMonthsStr(currentMonthStr(), -1));
  const prevMonth = addMonthsStr(currentMonthStr(), -1);
  const [pending, setPending] = useState<PendingSummary | null>(null);
  const [run, setRun] = useState<RunSummaryDTO | null | undefined>(undefined); // undefined＝載入中；null＝未開始
  const [needsBoss, setNeedsBoss] = useState<number | null>(null);

  useEffect(() => {
    if (!canRosterUploads) return;
    let cancelled = false;
    (async () => {
      // 唔帶 month＝預設「本月＋上月」未對完嘅上載（API 預設 months=2；上個月更表通常今個月先對數）。
      const res = await apiGet<PendingSummary>("/api/roster-uploads/pending-summary");
      if (!cancelled && res.ok) setPending(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [canRosterUploads]);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    if (!canMonthClose) return;
    let cancelled = false;
    setRun(undefined);
    (async () => {
      const res = await apiGet<{ runs: RunSummaryDTO[] }>(`/api/month-close/one-click?month=${month}`);
      if (cancelled) return;
      setRun(res.ok ? (res.data.runs[0] ?? null) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [canMonthClose, month, monthReady]);

  useEffect(() => {
    if (!canGuardFix) return;
    let cancelled = false;
    (async () => {
      const res = await apiGet<GuardFixRunsResponse>("/api/guard-fix/runs");
      if (cancelled || !res.ok) return;
      const latest = res.data.runs[0];
      setNeedsBoss(latest ? (latest.summary?.needs_boss ?? 0) : null); // 冇 run＝唔出呢格
    })();
    return () => {
      cancelled = true;
    };
  }, [canGuardFix]);

  const showApprovals = approvals !== null;
  const showTriage = triage !== null;
  if (!showApprovals && !showTriage && !canRosterUploads && !canMonthClose && !(canGuardFix && needsBoss !== null)) return null;

  let runCard: React.ReactNode = null;
  if (canMonthClose) {
    const label = `${month} 月結`;
    if (run === undefined) runCard = <Card testId="inbox-month-close" label={label} value="…" href="/month-close" />;
    else if (run === null) runCard = <Card testId="inbox-month-close" label={label} value="未開始" href="/month-close" />;
    else if (run.status === "done") runCard = <Card testId="inbox-month-close" label={label} value="已完成" tone="ok" note={`${run.steps_done}/${run.steps_total} 步`} href="/month-close" />;
    else if (run.status === "failed") runCard = <Card testId="inbox-month-close" label={label} value="失敗" tone="danger" note={`${run.steps_done}/${run.steps_total} 步`} href="/month-close" />;
    else runCard = <Card testId="inbox-month-close" label={label} value="進行中" note={`${run.steps_done}/${run.steps_total} 步`} href="/month-close" />;
  }

  return (
    <section aria-label="待辦" data-testid="home-inbox" className="flex flex-col gap-1.5">
      <h2 className="text-sm font-semibold text-zk-text">待辦</h2>
      <div className="flex flex-wrap gap-2.5">
        {showApprovals && <Card testId="inbox-approvals" label="待審批" value={approvals} unit="更" tone={approvals > 0 ? "danger" : undefined} href="/approvals" />}
        {showTriage && <Card testId="inbox-triage" label="待答問題" value={triage} unit="題" tone={triage > 0 ? "danger" : undefined} href="/triage" />}
        {canRosterUploads && (
          <Card
            testId="inbox-unreconciled"
            label="更表未對數"
            value={pending ? pending.entries.length : "…"}
            unit={pending ? "盤" : undefined}
            tone={pending && pending.entries.length > 0 ? "danger" : undefined}
            note={pending && pending.entries.length > 0 ? pending.entries.slice(0, 3).map((e) => `${e.site_name} ${e.pending_count} 格`).join("、") + (pending.name_only && pending.name_only.total > 0 ? `；${pending.name_only.total} 格淨靠姓名配對` : "") : undefined}
            href={pending && pending.entries.length > 0 ? `/roster-uploads?month=${pending.entries.map((e) => e.month).sort()[0]}` : "/roster-uploads"}
          />
        )}
        {runCard}
        {canGuardFix && needsBoss !== null && <Card testId="inbox-needs-boss" label="要老闆決定" value={needsBoss} unit="項" tone={needsBoss > 0 ? "danger" : undefined} href={`/roster-uploads?tab=fix&month=${prevMonth}`} />}
      </div>
    </section>
  );
}
