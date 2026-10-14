"use client";
// 1a ③ 進度：10 行 grid `28px 128px 1fr auto 72px`，每步一句人話總結＋chip＋耗時；撳行展開技術明細（原 key=value）。
import { useState } from "react";
import Link from "next/link";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import type { RunDTO } from "@/components/month-close/types";
import { humanize, deriveAutoCategories, stepChips, stepKv, stepSeconds, stepSummary } from "@/components/month-close/derive";

function Dot({ status, q }: { status: string; q: number }) {
  let cls = "bg-zk-success-tint text-zk-success";
  let mark = "✓";
  if (status === "failed") {
    cls = "bg-zk-danger-tint text-zk-danger-dark";
    mark = "✕";
  } else if (status === "running") {
    cls = "bg-zk-primary-tint text-zk-primary-deep";
    mark = "…";
  } else if (status === "pending") {
    cls = "bg-zk-surface text-zk-faint";
    mark = "·";
  } else if (status === "skipped") {
    cls = "bg-zk-surface text-zk-muted";
    mark = "–";
  } else if (q > 0) {
    cls = "bg-zk-warning-tint text-zk-warning";
    mark = "!";
  }
  return <span className={`col-start-1 row-span-3 row-start-1 flex h-5 w-5 items-center justify-center self-start rounded-full text-zk-xs font-bold lg:row-span-1 lg:self-center ${cls}`}>{mark}</span>;
}

export function ProgressSection({ run, busy, locked, onRerun }: { run: RunDTO; busy: boolean; locked: boolean; onRerun: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  // P3-4.3（H12）：全部跑完、冇出錯、冇要人手處理就摺成一行「N / N 步完成」；有錯／有要人睇先展開。
  const clean = run.status === "done" && !run.stalled && !run.error_message && run.steps.length > 0 && run.steps.every((st) => (st.status === "done" || st.status === "skipped") && st.needs_human.length === 0);
  const [expanded, setExpanded] = useState(false);
  // 桌面：clean 先摺；手機（<lg）：一律預設摺（10 行好長），撳「展開」先見；有要人手處理嘅步驟標題列講明。
  const showSteps = !clean || expanded;
  const needsHumanSteps = run.steps.filter((st) => st.needs_human.length > 0).length;
  const stepsCls = expanded ? "" : "max-lg:hidden";
  const auto = run.report?.auto;
  const autoTotal = auto ? deriveAutoCategories(auto).total : 0;
  const qTotal = auto?.review.length ?? 0;
  const doneN = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const headline = run.status === "running" && !run.stalled ? `執行緊 · ${doneN} / ${run.steps.length} 步` : run.status === "failed" || run.stalled ? `${doneN} / ${run.steps.length} 步完成，之後停咗` : `${run.steps.length} 步全部跑完${auto ? ` · 自動做咗 ${autoTotal} 項 · 出咗 ${qTotal} 題` : ""}`;
  return (
    <section id="progress-section" className="scroll-mt-4 overflow-hidden rounded-[10px] border border-zk-border bg-white" data-testid="progress-section">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-zk-border-soft px-4 py-3">
        <h2 className="text-zk-md font-semibold text-zk-text">③ 進度</h2>
        <span className="text-zk-sm text-zk-muted">{headline}</span>
        <span className="ml-auto hidden items-center gap-3 text-zk-xs text-zk-muted lg:flex">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-zk-success-tint" />
            自動做咗
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-zk-warning-tint" />
            要你睇
          </span>
        </span>
        {needsHumanSteps > 0 && <span className="text-zk-sm font-semibold text-zk-danger-dark lg:hidden">{needsHumanSteps} 步有項目要人手處理</span>}
        <Button variant="link" size="sm" className={`ml-auto lg:ml-0 ${clean ? "" : "lg:hidden"}`} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} data-testid="progress-toggle">
          {expanded ? "收埋 ‹" : clean ? `${run.steps.length} / ${run.steps.length} 步完成 · 展開 ›` : "展開 ›"}
        </Button>
        {(run.stalled || run.status === "failed") && (
          <Button variant="dark" onClick={onRerun} disabled={busy || locked}>
            重新執行
          </Button>
        )}
      </div>
      {(run.stalled || run.error_message) && (
        <div className="flex flex-col gap-2 border-b border-zk-border-soft px-4 py-3">
          {run.stalled && <Banner kind="error" message="呢個 run 卡住咗（超過 15 分鐘冇進度）——撳「重新執行」安全（冪等，唔會重複計）" />}
          {run.error_message && <Banner kind="error" message={humanize(run.error_message)} />}
        </div>
      )}
      {showSteps && <div className={clean ? "" : stepsCls}>
        {run.steps.map((s) => {
          const chips = stepChips(s.key, auto);
          const isOpen = open === s.key;
          const kv = stepKv(s);
          return (
            <div key={s.key} className="border-b border-zk-border-soft last:border-b-0" data-step={s.key}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : s.key)}
                className="grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left hover:bg-zk-header lg:grid-cols-[28px_128px_minmax(0,1fr)_auto_72px]"
              >
                <Dot status={s.status} q={chips.q} />
                <span className="col-start-2 row-start-1 text-zk-base font-medium text-zk-text">{s.label}</span>
                <span className="col-start-2 row-start-2 min-w-0 text-zk-sm text-zk-text-secondary lg:col-start-3 lg:row-start-1" data-testid="step-summary">
                  {stepSummary(s)}
                </span>
                <span className="col-start-2 row-start-3 flex gap-1.5 whitespace-nowrap empty:hidden lg:col-start-4 lg:row-start-1">
                  {chips.auto > 0 && <span className="rounded-[10px] bg-zk-success-tint px-2 py-0.5 text-zk-xs font-semibold text-zk-success">自動 {chips.auto}</span>}
                  {chips.q > 0 && <span className="rounded-[10px] bg-zk-warning-tint px-2 py-0.5 text-zk-xs font-semibold text-zk-warning">{chips.q} 題</span>}
                </span>
                <span className="col-start-3 row-start-1 text-right text-zk-xs text-zk-faint lg:col-start-5">{stepSeconds(s)}</span>
              </button>
              {s.needs_human.length > 0 && (
                <ul className="mx-4 mb-2 list-disc pl-6 text-zk-xs text-zk-danger-dark lg:ml-14" data-testid="step-needs-human">
                  {s.needs_human.map((w, i) => (
                    <li key={i}>
                      {humanize(w)}
                      {s.key === "longterm_settlement" && w.startsWith("病假") && (
                        <Link href={`/reports/longterm-payroll?month=${run.month.slice(0, 7)}&focus=sl-drafts`} className="ml-2 whitespace-nowrap text-zk-primary hover:underline" data-testid="needs-human-sl-link">
                          去確認病假 ›
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {isOpen && (
                <div className="mx-4 mb-3 rounded-md border border-zk-border bg-zk-surface-2 px-3 py-2.5 lg:ml-14">
                  {s.warnings.length > 0 && (
                    <ul className="mb-2 list-disc pl-4 text-zk-xs text-zk-warning">
                      {s.warnings.map((w, i) => (
                        <li key={i}>{humanize(w)}</li>
                      ))}
                    </ul>
                  )}
                  <details data-testid="step-tech">
                    <summary className="cursor-pointer text-zk-2xs font-semibold tracking-[.04em] text-zk-faint">技術明細 · 俾 IT 對數用</summary>
                    {kv.length === 0 ? (
                      <div className="mt-1.5 text-zk-xs text-zk-faint">冇技術明細</div>
                    ) : (
                      <div className="mt-1.5 grid grid-cols-1 gap-x-[18px] gap-y-[3px] font-mono text-zk-xs text-zk-text-secondary sm:grid-cols-2 lg:grid-cols-3" data-testid="step-kv">
                        {kv.map((x) => (
                          <span key={x} className="break-all">
                            {x}
                          </span>
                        ))}
                      </div>
                    )}
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>}
    </section>
  );
}
