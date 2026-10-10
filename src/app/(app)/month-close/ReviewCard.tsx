"use client";
// 1a 「要你睇」卡（橙邊）：4 欄按題型分組（定價／保安員配對／結算雞頭／更數差異）各頭 2 題＋「再多 N 題 ›」。
// P3-3.4：「開始逐條答」掣只留右欄 RightRail（唯一 CTA 區，testid rail-open-triage）；呢張卡淨係「再多 N 題 ›」文字連結。
// 現有 MonthCloseTriageDialog（桌面照用；手機 <768px 由 dialog 自己切 1e 一次一題）。
import Link from "next/link";
import { Pill } from "@/components/ui/Pill";
import type { AutoReportDTO } from "@/components/month-close/types";
import { humanize, reviewTotals, type ReviewGroup } from "@/components/month-close/derive";

export function ReviewCard({ auto, groups, busy, locked, onOpenTriage }: { auto: AutoReportDTO; groups: ReviewGroup[]; busy: boolean; locked: boolean; onOpenTriage: () => void }) {
  const t = reviewTotals(auto.review);
  const canAnswer = !!auto.triage_session_id && t.total > 0;
  return (
    <div className="overflow-hidden rounded-[10px] border border-zk-warning-border bg-white" data-testid="auto-review">
      <div className="flex flex-wrap items-center gap-3 border-b border-zk-warning-border bg-zk-warning-bg px-4 py-3.5">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-zk-warning-tint text-zk-base font-bold text-zk-warning">?</span>
        <div className="min-w-0">
          <div className="text-zk-md font-semibold text-zk-text">{t.total === 0 ? "要你睇：冇" : `要你睇：仲有 ${t.total} 題`}</div>
          <div className="text-zk-sm text-zk-muted">{t.total === 0 ? "冇要你睇嘅項目——系統全部有建議、已自動處理。" : `系統唔肯自己決定嘅嘢。${t.propose} 題有建議答案，${t.unknown} 題要你自己揀；唔答都得，跳過就留返人手處理。`}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/triage" className="text-zk-sm text-zk-muted underline">
            去分診頁
          </Link>
        </div>
      </div>
      {t.total > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {groups.map((g) => (
            <div key={g.key} className="flex min-w-0 flex-col gap-2 border-b border-r border-zk-border-soft px-4 py-3" data-review-group={g.key}>
              <div className="flex items-baseline gap-1.5">
                <span className="text-zk-base font-semibold text-zk-text">{g.name}</span>
                <span className="text-lg font-bold text-zk-text">{g.count}</span>
                {g.count > 0 && (
                  <span className="ml-auto text-zk-xs text-zk-muted">
                    {g.propose} 有建議{g.unknown > 0 ? ` · ${g.unknown} 要揀` : ""}
                  </span>
                )}
              </div>
              {g.count === 0 && <div className="text-zk-sm text-zk-faint">冇</div>}
              {g.preview.map((it, i) => (
                <div key={i} className="border-t border-dashed border-zk-border pt-1.5 text-zk-sm leading-snug text-zk-text-secondary">
                  <Pill variant={it.confidence === "propose" ? "shift" : "warning"}>{it.confidence === "propose" ? "有建議" : "要你揀"}</Pill> {humanize(it.text)}
                </div>
              ))}
              {g.more > 0 &&
                (canAnswer ? (
                  <button type="button" className="text-left text-zk-xs text-zk-primary disabled:opacity-[.45]" onClick={onOpenTriage} disabled={busy || locked}>
                    再多 {g.more} 題 ›
                  </button>
                ) : (
                  <div className="text-zk-xs text-zk-primary">再多 {g.more} 題</div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
