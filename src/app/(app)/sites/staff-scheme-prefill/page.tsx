"use client";
// SITE-SCHEME-1／1.1：未設工號體系嘅盤——只對有更次嘅盤出建議；每行預設唔剔，逐個剔或「全選建議 U／MP」，「套用已剔」一撳寫入；
// 歸屬補推導喺背景行，頁面輪詢結果，並清楚顯示補咗幾多、仲有幾多更推唔到。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";
import { currentMonthStr } from "@/lib/ui/format";

interface Proposal {
  site_id: string;
  site_name: string;
  client_name: string;
  guards_paid_by_client: boolean;
  proposed_scheme: "U" | "MP";
  reason: string;
  shifts: number;
}
interface NotApplicable {
  site_id: string;
  site_name: string;
  client_name: string;
  shifts: number;
  reason: string;
}
interface ApplyResult {
  applied: number;
  by_scheme: Array<{ scheme: string; count: number }>;
  job_id: string | null;
  status?: string;
  summary?: JobSummary;
}
interface JobSummary {
  backfilled?: number;
  unresolved?: number;
  unresolved_by_month?: Array<{ month: string; count: number }>;
  error?: string;
  error_code?: string;
  message?: string;
}

// S-batch-1021：輪詢超過 10 分鐘仲 running → 提示可能已中斷（scheduler stale 門檻 15 分鐘會再標 error）
const JOB_POLL_MAX_MS = 10 * 60 * 1000;
const STALE_JOB_NOTICE = "背景補歸屬等咗超過 10 分鐘仲未完，可能已中斷——盤體系已設定，可以重新套用（只填空位，重做安全）";

/** 推唔到更次最多嘅月份（job summary.unresolved_by_month 已排好）；冇就當月 */
function topUnresolvedMonth(s: JobSummary | undefined): string {
  const m = s?.unresolved_by_month?.[0]?.month;
  return m && /^\d{4}-\d{2}$/.test(m) ? m : currentMonthStr();
}

export default function StaffSchemePrefillPage() {
  const [rows, setRows] = useState<Proposal[] | null>(null);
  const [notApplicable, setNotApplicable] = useState<NotApplicable[]>([]);
  const [noShifts, setNoShifts] = useState(0);
  const [choice, setChoice] = useState<Record<string, "U" | "MP">>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({}); // 預設全部唔剔
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unresolvedMonth, setUnresolvedMonth] = useState<string>(currentMonthStr()); // 推唔到最多嗰個月；冇就當月
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await apiGet<{ count: number; proposals: Proposal[]; not_applicable: NotApplicable[]; no_shifts: number }>("/api/sites/staff-scheme-prefill");
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows(res.data.proposals);
    setNotApplicable(res.data.not_applicable);
    setNoShifts(res.data.no_shifts);
    setChoice(Object.fromEntries(res.data.proposals.map((p) => [p.site_id, p.proposed_scheme])));
    setTicked({});
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const tickedIds = (rows ?? []).filter((p) => ticked[p.site_id]).map((p) => p.site_id);
  const tickWhere = (pred: (p: Proposal) => boolean) => setTicked(Object.fromEntries((rows ?? []).map((p) => [p.site_id, pred(p)])));

  function resultNotice(applied: number, s: JobSummary): string {
    const base = `已設定 ${applied} 個盤；補歸屬 ${s.backfilled ?? 0} 更`;
    return (s.unresolved ?? 0) > 0 ? `${base}；仲有 ${s.unresolved} 更推唔到（人冇對應體系嘅工號卡）` : base;
  }

  async function pollJob(jobId: string, applied: number) {
    const deadline = Date.now() + JOB_POLL_MAX_MS;
    while (alive.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await apiGet<{ job: { status: string; summary: JobSummary } }>(`/api/sites/staff-scheme-prefill?job=${encodeURIComponent(jobId)}`);
      if (!r.ok) continue;
      if (r.data.job.status === "ok") {
        setNotice(resultNotice(applied, r.data.job.summary ?? {}));
        setUnresolvedMonth(topUnresolvedMonth(r.data.job.summary));
        return;
      }
      if (r.data.job.status === "error") {
        const sm = r.data.job.summary ?? {};
        setError(`背景補歸屬失敗（盤體系已設定）${sm.error_code ? `〔${sm.error_code}〕` : ""}——可以稍後喺月結健康「未標工號」卡用回填工具補，或重新套用`);
        return;
      }
    }
    if (alive.current) setNotice(STALE_JOB_NOTICE);
  }

  async function applyTicked() {
    if (tickedIds.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const overrides = (rows ?? []).filter((p) => ticked[p.site_id] && choice[p.site_id] !== p.proposed_scheme).map((p) => ({ site_id: p.site_id, scheme: choice[p.site_id]! }));
    const res = await apiPost<ApplyResult>("/api/sites/staff-scheme-prefill", { apply: true, site_ids: tickedIds, ...(overrides.length ? { overrides } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const d = res.data;
    await load();
    if (d.job_id && d.status === "running") {
      setNotice(`已設定 ${d.applied} 個盤（${d.by_scheme.map((b) => `${b.scheme} ${b.count}`).join("／")}）；更次歸屬背景補緊…`);
      void pollJob(d.job_id, d.applied);
    } else if (d.summary) {
      setNotice(resultNotice(d.applied, d.summary));
      setUnresolvedMonth(topUnresolvedMonth(d.summary));
    }
    else setNotice(`已設定 ${d.applied} 個盤`);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="staff-scheme-prefill-page">
      <PageHeader
        kicker={kickerFor("/sites/staff-scheme-prefill")}
        title="盤工號體系（預設建議）"
        subtitle="只列有更次嘅盤。客戶／盤名／別名含 Wilson 或威信 → U，其餘 → MP（LINK 盤照客戶判）。每行預設唔剔：逐個剔，或用「全選建議 U／MP」，再撳「套用已剔」。套用後歸屬補推導喺背景行（只填空位）。"
        actions={
          <>
            <Button variant="ghost" disabled={!rows || rows.length === 0} onClick={() => tickWhere((p) => choice[p.site_id] === "U")} data-testid="prefill-tick-u">
              全選建議 U
            </Button>
            <Button variant="ghost" disabled={!rows || rows.length === 0} onClick={() => tickWhere((p) => choice[p.site_id] === "MP")} data-testid="prefill-tick-mp">
              全選建議 MP
            </Button>
            <Button variant="primary" disabled={busy || tickedIds.length === 0} onClick={() => void applyTicked()} data-testid="prefill-apply-ticked">
              {busy ? "套用緊…" : `套用已剔（${tickedIds.length}）`}
            </Button>
          </>
        }
      />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {notice && notice.includes("推唔到") && (
        <div className="text-zk-sm text-zk-muted" data-testid="prefill-unresolved-hint">
          推唔到嘅更次會喺 <Link href={`/month-close?month=${unresolvedMonth}#health-shifts_no_staff_number`} className="text-zk-primary" data-testid="prefill-unresolved-link">月結健康「未標工號」卡 ›</Link> 繼續跟進（補返該人嘅工號卡後再回填）。
        </div>
      )}
      {rows === null ? (
        <div className="text-zk-base text-zk-muted">載入緊…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-zk-border bg-white px-4 py-6 text-zk-base text-zk-muted" data-testid="prefill-empty">
          冇需要設定嘅盤（有更次而未設體系嘅盤已清）。 <Link href="/sites" className="text-zk-primary">返去盤 ›</Link>
        </div>
      ) : (
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(5) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>剔</th>
                <th className={tableCls.th}>盤</th>
                <th className={tableCls.th}>客戶</th>
                <th className={tableCls.th}>建議體系</th>
                <th className={tableCls.th}>理由</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.site_id} className={tableCls.rowHover} data-testid={`prefill-row-${p.site_id}`}>
                  <td className={tableCls.td}>
                    <input type="checkbox" checked={!!ticked[p.site_id]} onChange={(e) => setTicked((t) => ({ ...t, [p.site_id]: e.target.checked }))} aria-label={`剔 ${p.site_name}`} />
                  </td>
                  <td className={tableCls.td}>
                    {p.site_name}
                    {p.guards_paid_by_client && <Pill variant="neutral">LINK</Pill>}
                    <span className="ml-1 text-zk-xs text-zk-muted">（{p.shifts} 更）</span>
                  </td>
                  <td className={tableCls.td}>{p.client_name}</td>
                  <td className={tableCls.td}>
                    <select className={selectCls} value={choice[p.site_id] ?? p.proposed_scheme} onChange={(e) => setChoice((c) => ({ ...c, [p.site_id]: e.target.value as "U" | "MP" }))} aria-label={`${p.site_name} 工號體系`}>
                      <option value="U">U（Wilson 盤）</option>
                      <option value="MP">MP（在勤盤）</option>
                    </select>
                  </td>
                  <td className={tableCls.td}>{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notApplicable.length > 0 && (
        <section className="rounded-lg border border-zk-border bg-white px-4 py-3" data-testid="prefill-not-applicable">
          <div className="text-zk-sm font-semibold text-zk-text">唔適用（{notApplicable.length}）——結算更次全部係客戶自己人（external），唔出建議</div>
          <ul className="mt-1.5 space-y-0.5 text-zk-sm text-zk-muted">
            {notApplicable.map((n) => (
              <li key={n.site_id}>
                {n.site_name}（{n.client_name}，{n.shifts} 更）
              </li>
            ))}
          </ul>
        </section>
      )}
      {noShifts > 0 && <div className="text-zk-xs text-zk-muted">另有 {noShifts} 個未設體系嘅盤完全冇更次，唔列出（有更次先需要設）。</div>}
    </div>
  );
}
