"use client";
// 1a 「要你睇」卡（橙邊）：4 欄按題型分組（定價／安員配對／結算雞頭／更數差異）各頭 2 題＋「再多 N 題 ›」。
// 「開始逐條答」開現有 MonthCloseTriageDialog（桌面照用；手機 <768px 由 dialog 自己切 1e 一次一題）。
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import type { AutoReportDTO } from "@/components/month-close/types";
import { reviewTotals, type ReviewGroup } from "@/components/month-close/derive";

export function ReviewCard({ auto, groups, busy, onOpenTriage }: { auto: AutoReportDTO; groups: ReviewGroup[]; busy: boolean; onOpenTriage: () => void }) {
  const t = reviewTotals(auto.review);
  const canAnswer = !!auto.triage_session_id && t.total > 0;
  return (
    <div className="overflow-hidden rounded-[10px] border border-[#fed7aa] bg-white" data-testid="auto-review">
      <div className="flex flex-wrap items-center gap-3 border-b border-[#fde4c4] bg-[#fffbf5] px-4 py-3.5">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#ffedd5] text-[13px] font-bold text-[#c2410c]">?</span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-zk-text">{t.total === 0 ? "要你睇：冇" : `要你睇：仲有 ${t.total} 題`}</div>
          <div className="text-[12px] text-zk-muted">{t.total === 0 ? "冇要你睇嘅項目——系統全部有依據、已自動處理。" : `系統唔肯自己決定嘅嘢。${t.propose} 題有建議答案，${t.unknown} 題要你自己揀；唔答都得，跳過就留返人手處理。`}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/triage" className="text-[12px] text-zk-muted underline">
            去分診頁
          </Link>
          {canAnswer && (
            <Button variant="primary" className="!px-4 !py-2 font-semibold" onClick={onOpenTriage} disabled={busy} data-testid="open-triage">
              開始逐條答（{t.total}）
            </Button>
          )}
        </div>
      </div>
      {t.total > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {groups.map((g) => (
            <div key={g.key} className="flex min-w-0 flex-col gap-2 border-b border-r border-zk-border-soft px-4 py-3" data-review-group={g.key}>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-semibold text-zk-text">{g.name}</span>
                <span className="text-lg font-bold text-zk-text">{g.count}</span>
                {g.count > 0 && (
                  <span className="ml-auto text-[11px] text-zk-muted">
                    {g.propose} 有建議{g.unknown > 0 ? ` · ${g.unknown} 要揀` : ""}
                  </span>
                )}
              </div>
              {g.count === 0 && <div className="text-[12px] text-zk-faint">冇</div>}
              {g.preview.map((it, i) => (
                <div key={i} className="border-t border-dashed border-zk-border pt-1.5 text-[12px] leading-snug text-[#334155]">
                  <Pill variant={it.confidence === "propose" ? "shift" : "warning"}>{it.confidence === "propose" ? "有建議" : "要你揀"}</Pill> {it.text}
                </div>
              ))}
              {g.more > 0 &&
                (canAnswer ? (
                  <button type="button" className="text-left text-[11.5px] text-zk-primary" onClick={onOpenTriage}>
                    再多 {g.more} 題 ›
                  </button>
                ) : (
                  <div className="text-[11.5px] text-zk-primary">再多 {g.more} 題</div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
