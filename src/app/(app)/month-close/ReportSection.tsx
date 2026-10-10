"use client";
// 1a ④ 報告：3 KPI 卡（總成本堆疊條）、未定價橫幅、長工糧一行、自動處理摘要、要你睇、逐雞頭應付、逐盤收入、Postorder 對照。
// 金額欄按角色「—」（fmtMoney 對缺欄位回「—」）。原本 ④ 下面紅色「要人決定」清單已刪除（同 ③／要你睇重複）。
import { useState } from "react";
import Link from "next/link";
import { fmtMoney } from "@/lib/ui/format";
import type { ReportDTO, RunDTO } from "@/components/month-close/types";
import { humanize, deriveCostStack, fmtMdHm, marginPct, splitSiteRevenue, type ReviewGroup } from "@/components/month-close/derive";
import { AutoSummaryCard } from "./AutoSummaryCard";
import { ReviewCard } from "./ReviewCard";
import { PostorderDependencyLine } from "./PostorderDependencyLine";

const card = "rounded-[10px] border border-zk-border bg-white";
const STACK_COLOR = { shift: "#2563eb", referral: "#93c5fd", autopay: "#0f766e" } as const;

export function ReportSection({ run, report, busy, locked, groups, onUndo, onOpenTriage }: { run: RunDTO; report: ReportDTO; busy: boolean; locked: boolean; groups: ReviewGroup[]; onUndo: () => void; onOpenTriage: () => void }) {
  const [showAllSites, setShowAllSites] = useState(false);
  const stack = deriveCostStack(report.combined_cost_summary);
  const pct = marginPct(report.totals);
  const cs = report.combined_cost_summary;
  const siteCount = report.site_revenue.length;
  const shiftSum = report.site_revenue.reduce((a, r) => a + (typeof r.shifts === "number" ? r.shifts : 0), 0);
  const gap = report.unpriced.gap;
  const sr = splitSiteRevenue(report.site_revenue);
  const sitesShown = showAllSites ? [...sr.shown, ...sr.rest] : sr.shown;
  const settlementQ = groups.find((g) => g.key === "settlement")?.count ?? 0;
  const zeroBrokers = report.payroll_by_broker.filter((b) => b.broker_code !== "" && b.amount === 0);
  const lt = report.longterm_payroll;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-section">
      <div className="flex flex-wrap items-baseline gap-2.5 px-0.5 pt-1.5">
        <h2 className="text-base font-bold text-zk-text">④ 報告 · {report.month}</h2>
        <span className="text-[12px] text-zk-muted">{fmtMdHm(run.finished_at ?? run.started_at)} 嗰次結算</span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className={`${card} px-[18px] py-4`}>
          <div className="text-[12px] text-zk-muted">總收入</div>
          <div className="mt-1 break-all text-[28px] font-bold leading-tight text-zk-text">{fmtMoney(report.totals.revenue)}</div>
          <div className="mt-1.5 text-[11.5px] text-zk-muted">{siteCount} 個盤 · {fmtMoney(shiftSum)} 更</div>
        </div>
        <div className={`${card} px-[18px] py-4`}>
          <div className="text-[12px] text-zk-muted">總成本{report.totals.cost_basis === "combined" ? "（合併）" : "（毛利表口徑）"}</div>
          <div className="mt-1 break-all text-[28px] font-bold leading-tight text-zk-text">{fmtMoney(report.totals.cost)}</div>
          {stack && (
            <>
              <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-[3px] bg-zk-surface" data-testid="cost-stack">
                {stack.parts.map((p) => (
                  <span key={p.key} style={{ width: `${p.pct}%`, background: STACK_COLOR[p.key] }} />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zk-muted">
                <span><span style={{ color: STACK_COLOR.shift }}>●</span> 更次 {fmtMoney(stack.parts[0]!.value)}</span>
                <span><span style={{ color: STACK_COLOR.referral }}>●</span> 介紹費 {fmtMoney(stack.parts[1]!.value)}（{report.referral_fee.count} 項）</span>
                <span><span style={{ color: STACK_COLOR.autopay }}>●</span> 長工 Autopay {fmtMoney(stack.parts[2]!.value)}</span>
              </div>
            </>
          )}
        </div>
        <div className={`${card} px-[18px] py-4`}>
          <div className="text-[12px] text-zk-muted">毛利{report.totals.cost_basis === "combined" ? "（合併口徑）" : ""}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <span className="break-all text-[28px] font-bold leading-tight text-zk-text">{fmtMoney(report.totals.gross_margin)}</span>
            {pct !== null && <span className="text-[13px] font-semibold text-zk-success">{pct}%</span>}
          </div>
          <details className="mt-1.5 text-[11.5px] text-zk-muted" data-testid="margin-why">
            <summary className="cursor-pointer">
              同「毛利即時表」唔同係正常 <span className="text-zk-primary">點解？</span>
            </summary>
            <div className="mt-1.5 leading-relaxed text-zk-faint">
              {report.totals.margin_revenue !== undefined && <>成本／毛利嘅營業額跟「毛利即時表」口徑（{fmtMoney(report.totals.margin_revenue)}，唔計月結以外收入）。</>}
              {report.totals.cost_basis === "combined"
                ? `總成本用合併口徑：長工人工用「長工糧」真實 Autopay（唔再用按更數估算）、MPF 僱主另列唔計入。「毛利即時表」頁嘅成本仲係舊估算口徑（${fmtMoney(report.totals.legacy_cost ?? 0)}，毛利 ${fmtMoney(report.totals.legacy_margin ?? 0)}），兩個數唔同係正常。`
                : "總成本係毛利表口徑（長工月薪按更數估算分攤）。"}
              {cs && <> 「更次成本」＝散工更×出街價；MPF 僱主 {fmtMoney(cs.mpf_er_total)} 另列，唔計入合計（§16.2）。</>}
              {cs?.visa_passthrough_autopay_excluded ? ` 長工 Autopay 已剔走簽證形式長工 ${fmtMoney(cs.visa_passthrough_autopay_excluded)}（雞頭結算扣返，唔係公司成本；糧單照出）。` : ""}
            </div>
          </details>
        </div>
      </div>

      {report.unpriced.count > 0 && (
        <div className="flex items-center gap-2.5 rounded-lg border border-[#fed7aa] bg-[#fff7ed] px-3.5 py-2.5 text-[12.5px] text-[#9a3412]" data-testid="unpriced-gap">
          <span className="h-2 w-2 flex-none rounded-full bg-[#ea580c]" />
          <span>
            <b>{report.unpriced.count} 更未定價，未計入成本。</b>
            未定價更數唔當 0 成本：上面成本／毛利未包呢 {report.unpriced.count} 更（收客 {report.unpriced.client_count}／出街 {report.unpriced.payout_count}／冇結算單位 {report.unpriced.no_settlement_count}／OT {report.unpriced.ot_unpriced_count}）。
            {gap && (gap.client_gap_estimate !== null || gap.payout_gap_estimate !== null)
              ? `估算缺口（按同盤同更種最近已知價，只作提示）：收入約 ${gap.client_gap_estimate !== null ? fmtMoney(gap.client_gap_estimate) : "—"}／成本約 ${gap.payout_gap_estimate !== null ? fmtMoney(gap.payout_gap_estimate) : "—"}${gap.no_reference_records > 0 ? `；另有 ${gap.no_reference_records} 更冇任何參考價` : ""}。答完「要你睇」嘅定價題就會補返。`
              : "冇參考價可以估算。"}
          </span>
        </div>
      )}

      <div className={`${card} flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-[12.5px] text-zk-muted`}>
        <span className="font-semibold text-[#334155]">長工糧</span>
        {lt && lt.guard_count > 0 ? (
          <span>
            {lt.guard_count} 人 · Gross {fmtMoney(lt.gross_total)} · Autopay {fmtMoney(lt.autopay_total)} · MPF 僱員 {fmtMoney(lt.mpf_ee_total)} · MPF 僱主 {fmtMoney(lt.mpf_er_total)}
          </span>
        ) : (
          <span>本月 0 位長工有糧計入。</span>
        )}
        {report.longterm_payroll_note && <span className="min-w-0 text-zk-faint">{humanize(report.longterm_payroll_note)}</span>}
        <Link href="/longterm-payroll" className="ml-auto whitespace-nowrap text-zk-primary hover:underline">
          去長工糧 ›
        </Link>
      </div>

      {report.auto && <AutoSummaryCard auto={report.auto} busy={busy} locked={locked} onUndo={onUndo} extraFooter={<PostorderDependencyLine auto={report.auto} month={report.month} />} />}
      {report.auto && <ReviewCard auto={report.auto} groups={groups} busy={busy} locked={locked} onOpenTriage={onOpenTriage} />}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className={`${card} overflow-hidden`}>
          <div className="flex items-baseline justify-between px-4 py-3 text-[13.5px] font-semibold">
            <h3>逐雞頭應付</h3>
            <span className="text-[12px] font-normal text-zk-muted">合共 {fmtMoney(report.payroll_by_broker.reduce((a, b) => a + (typeof b.amount === "number" ? b.amount : 0), 0))}</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_60px_100px] border-y border-zk-border bg-zk-header px-4 py-1.5 text-[11px] font-semibold text-zk-muted">
            <span>雞頭</span>
            <span className="text-right">更數</span>
            <span className="text-right">應付</span>
          </div>
          {report.payroll_by_broker.length === 0 && <div className="px-4 py-3 text-[12px] text-zk-faint">本月冇雞頭應付紀錄</div>}
          {report.payroll_by_broker.map((b) => {
            const unattributed = b.broker_code === "";
            return (
              <div key={b.broker_code || "unattributed"} className="grid grid-cols-[minmax(0,1fr)_60px_100px] items-center border-b border-zk-border-soft px-4 py-2 text-[12.5px]" style={{ background: unattributed ? "#fff7ed" : undefined }}>
                <span className="min-w-0 font-medium" style={{ color: unattributed ? "#c2410c" : b.amount === 0 ? "#94a3b8" : undefined }}>
                  {unattributed ? b.broker_name : `${b.broker_code}（${b.broker_name}）`}
                  {unattributed && settlementQ > 0 && <span className="ml-1.5 text-[11px] font-normal">待答 {settlementQ} 題</span>}
                </span>
                <span className="text-right">{b.shifts}</span>
                <span className="text-right" style={{ color: b.amount === 0 && !unattributed ? "#94a3b8" : undefined }}>{fmtMoney(b.amount)}</span>
              </div>
            );
          })}
          {zeroBrokers.length > 0 && <div className="px-4 py-2 text-[11.5px] text-zk-muted">{zeroBrokers.map((b) => b.broker_code).join("、")} 應付 0（如係公司長工／公司兵，應付 0 係正常）。</div>}
        </div>

        <div className={`${card} overflow-hidden`}>
          <div className="flex items-baseline justify-between px-4 py-3 text-[13.5px] font-semibold">
            <h3>逐盤收入</h3>
            <span className="text-[12px] font-normal text-zk-muted">按收入排 · {sr.shown.length + sr.rest.length} 個盤有更</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_60px_100px] border-y border-zk-border bg-zk-header px-4 py-1.5 text-[11px] font-semibold text-zk-muted">
            <span>盤</span>
            <span className="text-right">更數</span>
            <span className="text-right">收入</span>
          </div>
          {sitesShown.length === 0 && <div className="px-4 py-3 text-[12px] text-zk-faint">本月冇有更嘅盤</div>}
          {sitesShown.map((r) => (
            <div key={r.site_id} className="grid grid-cols-[minmax(0,1fr)_60px_100px] items-center border-b border-zk-border-soft px-4 py-2 text-[12.5px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{r.site_name}</span>
                <span className="hidden h-1 min-w-[20px] flex-1 overflow-hidden rounded-sm bg-zk-surface sm:block">
                  <span className="block h-full bg-[#bfdbfe]" style={{ width: `${sr.max > 0 && typeof r.revenue === "number" ? Math.max(2, (r.revenue / sr.max) * 100) : 0}%` }} />
                </span>
              </span>
              <span className="text-right">{r.shifts}</span>
              <span className="text-right">{fmtMoney(r.revenue)}</span>
            </div>
          ))}
          <div className="flex flex-wrap justify-between gap-2 px-4 py-2 text-[12px]">
            {sr.rest.length > 0 ? (
              <button type="button" className="text-zk-primary" onClick={() => setShowAllSites((v) => !v)}>
                {showAllSites ? "收埋 ›" : `顯示其餘 ${sr.rest.length} 個有更嘅盤 ›`}
              </button>
            ) : (
              <span />
            )}
            {sr.zeroCount > 0 && <span className="text-zk-faint">{sr.zeroCount} 個盤本月 0 更，已收埋</span>}
          </div>
        </div>
      </div>

      {report.postorder_compare && (
        <div className={`${card} flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[12.5px]`}>
          <span className="font-semibold">同 Postorder 總表對照</span>
          <span className="text-[#334155]">
            介紹費：系統 {fmtMoney(report.postorder_compare.referral_system_total)} · 總表 {report.postorder_compare.referral_excel_total !== null ? fmtMoney(report.postorder_compare.referral_excel_total) : "（總表冇提供）"}
            {report.postorder_compare.referral_diff !== null && (
              <>
                {" · "}
                <b className="text-[#c2410c]">差 {fmtMoney(report.postorder_compare.referral_diff)}</b>
              </>
            )}
          </span>
          <span className="text-zk-faint">{humanize(report.postorder_compare.note)}</span>
        </div>
      )}
    </div>
  );
}
