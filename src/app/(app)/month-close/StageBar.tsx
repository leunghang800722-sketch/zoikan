"use client";
// 1a 五步狀態列：白卡 5 欄（手機直排）。狀態由 deriveStages() 推。
import type { Stage } from "@/components/month-close/derive";

const DOT = {
  ok: { bg: "var(--zk-success)", fg: "var(--zk-card)", bd: "var(--zk-success)", cell: "var(--zk-card)", sub: "var(--zk-muted)" },
  warn: { bg: "var(--zk-warning-bg)", fg: "var(--zk-warning)", bd: "var(--zk-warning)", cell: "var(--zk-warning-bg)", sub: "var(--zk-warning)" },
  todo: { bg: "var(--zk-card)", fg: "var(--zk-faint)", bd: "var(--zk-faintest)", cell: "var(--zk-card)", sub: "var(--zk-faint)" },
} as const;

export function StageBar({ stages }: { stages: Stage[] }) {
  return (
    <ol className="flex overflow-x-auto rounded-[10px] border border-zk-border bg-white lg:grid lg:grid-cols-5 lg:overflow-hidden" data-testid="stage-bar">
      {stages.map((s, i) => {
        const c = DOT[s.state];
        return (
          <li key={s.key} data-stage={s.key} data-state={s.state} className="flex min-w-[124px] flex-none items-center gap-2 border-r border-zk-border-soft px-3 py-2.5 last:border-r-0 lg:min-w-0 lg:gap-2.5 lg:px-4 lg:py-3" style={{ background: c.cell }}>
            <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-zk-sm font-bold" style={{ background: c.bg, color: c.fg, border: `1.5px solid ${c.bd}` }}>
              {s.state === "ok" ? "✓" : i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-zk-base font-semibold text-zk-text">{s.name}</div>
              <div className="truncate text-zk-xs" style={{ color: c.sub }}>
                {s.sub}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
