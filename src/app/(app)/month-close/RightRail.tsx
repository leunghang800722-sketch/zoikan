"use client";
// 1a 右欄 sticky「本月仲差咩」：要你睇題數＋開始逐條答、未定價更數、未對數確認盤數、體檢嚴重項、鎖定掣、自動改動 N 項＋還原掣。
import type { ReportDTO } from "@/components/month-close/types";
import { UNDO_NOTE_SHORT, deriveAutoCategories, lockRequirements, reviewTotals } from "@/components/month-close/derive";

const card = "rounded-[10px] border border-zk-border bg-white";

export function RightRail({ needDiffReason, diffReason, onDiffReason, report, month, busy, locked, health, needsHuman, onOpenTriage, onLock, onUndo }: { needDiffReason: boolean; diffReason: string; onDiffReason: (v: string) => void; needsHuman: number; report: ReportDTO; month: string; busy: boolean; locked: boolean; health: { critical: number; warn: number; info: number } | null; onOpenTriage: () => void; onLock: () => void; onUndo: () => void }) {
  const auto = report.auto;
  const t = reviewTotals(auto?.review);
  const cats = auto ? deriveAutoCategories(auto) : null;
  const unconfirmed = report.lock_precondition.unconfirmed_upload_sites.length;
  const unpriced = report.unpriced.count;
  const ready = report.lock_precondition.ready_to_lock && !locked;
  const reqs = lockRequirements(report, 0);
  const rows: Array<{ c: string; t: string; v: string | number; href?: string }> = [
    { c: unpriced > 0 ? "var(--zk-warning)" : "var(--zk-success)", t: "更未定價", v: unpriced },
    { c: unconfirmed > 0 ? "var(--zk-danger)" : "var(--zk-success)", t: "個盤未對數確認", v: unconfirmed },
    { c: health && health.critical > 0 ? "var(--zk-danger)" : "var(--zk-success)", t: "體檢嚴重項", v: health ? health.critical : "—" },
    ...(needsHuman > 0 ? [{ c: "var(--zk-danger)", t: "項要人手處理（睇 ③ 進度）", v: needsHuman, href: "#progress-section" }] : []),
  ];
  return (
    <aside className="flex flex-col gap-3" data-testid="right-rail" aria-label="本月仲差咩">
      <div className={`${card} overflow-hidden`}>
        <div className="border-b border-zk-border-soft px-3.5 py-3 text-zk-base font-semibold">本月仲差咩</div>
        <div className="flex flex-col gap-1.5 border-b border-zk-border-soft p-3.5">
          <div className="flex items-baseline gap-2">
            <span className="text-zk-2xl font-bold leading-none" style={{ color: t.total > 0 ? "var(--zk-warning)" : "var(--zk-success)" }} data-testid="rail-review-count">
              {t.total}
            </span>
            <span className="text-zk-base font-medium">題要你睇</span>
          </div>
          <div className="text-zk-xs text-zk-muted">{t.total > 0 ? `${t.propose} 題有建議 · ${t.unknown} 題要自己揀` : "冇題要答"}</div>
          {auto?.triage_session_id && t.total > 0 && (
            <button type="button" onClick={onOpenTriage} disabled={busy || locked} data-testid="rail-open-triage" className="mt-1.5 rounded-[7px] bg-zk-primary py-[9px] text-zk-base font-semibold text-white hover:bg-zk-primary-dark disabled:opacity-[.45]">
              開始逐條答
            </button>
          )}
        </div>
        {rows.map((r) => (
          <div key={r.t} className="flex items-center gap-2.5 border-b border-zk-border-soft px-3.5 py-2.5 text-zk-sm">
            <span className="h-2 w-2 flex-none rounded-full" style={{ background: r.c }} />
            {r.href ? (
              <a href={r.href} className="flex-1 text-zk-primary hover:underline" data-testid="rail-needs-human">
                {r.t}
              </a>
            ) : (
              <span className="flex-1">{r.t}</span>
            )}
            <span className="font-bold">{r.v}</span>
          </div>
        ))}
        <div className="flex flex-col gap-1.5 p-3.5">
          {locked ? (
            <div className="text-center text-zk-sm font-semibold text-zk-warning">已鎖定</div>
          ) : (
            <>
              {needDiffReason && (
                <input className="rounded-[7px] border border-zk-input-border px-2.5 py-2 text-zk-sm" placeholder="§6.3 紅色差異：override 原因（必填）" value={diffReason} onChange={(e) => onDiffReason(e.target.value)} data-testid="rail-diff-reason" />
              )}
              <button type="button" onClick={onLock} disabled={busy || !ready || (needDiffReason && !diffReason.trim())} data-testid="rail-lock-month" className="rounded-[7px] bg-zk-dark py-[9px] text-zk-base font-semibold text-white disabled:cursor-not-allowed" style={{ opacity: ready ? 1 : 0.35 }}>
                鎖定 {month}
              </button>
              <div className="text-center text-zk-xs text-zk-faint">{ready ? "條件齊，可以鎖" : reqs.length > 0 ? "對數同定價做好就可以鎖" : "未可以鎖"}</div>
            </>
          )}
        </div>
      </div>
      {auto && cats && (
        <div className={`${card} flex flex-col gap-2 px-3.5 py-3`}>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-zk-success-tint text-zk-xs font-bold text-zk-success">✓</span>
            <span className="text-zk-sm font-semibold">自動改動 {cats.total} 項{auto.undone ? "（已還原）" : ""}</span>
          </div>
          {cats.cats.length > 0 && <div className="text-zk-xs leading-relaxed text-zk-muted">{cats.cats.map((c) => `${c.name} ${c.n}${c.unit}`).join(" · ")}</div>}
          <div className="text-zk-xs leading-snug text-zk-faint">{UNDO_NOTE_SHORT}</div>
          <button type="button" onClick={onUndo} disabled={busy || auto.undone || locked} data-testid="undo-auto-rail" className="rounded-[7px] border border-zk-danger-border bg-white py-2 text-zk-sm font-medium text-zk-danger-dark hover:bg-zk-danger-bg disabled:cursor-not-allowed disabled:opacity-[.45]">
            ↺ 還原所有自動改動
          </button>
        </div>
      )}
    </aside>
  );
}
