"use client";
// 1a 五步狀態列：白卡 5 欄（手機直排）。狀態由 deriveStages() 推。
import type { Stage } from "@/components/month-close/derive";

const DOT = {
  ok: { bg: "#0f766e", fg: "#ffffff", bd: "#0f766e", cell: "#ffffff", sub: "#64748b" },
  warn: { bg: "#fff7ed", fg: "#c2410c", bd: "#f97316", cell: "#fffbf5", sub: "#c2410c" },
  todo: { bg: "#ffffff", fg: "#94a3b8", bd: "#cbd5e1", cell: "#ffffff", sub: "#94a3b8" },
} as const;

export function StageBar({ stages }: { stages: Stage[] }) {
  return (
    <ol className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-zk-border bg-white md:grid-cols-5" data-testid="stage-bar">
      {stages.map((s, i) => {
        const c = DOT[s.state];
        return (
          <li key={s.key} data-stage={s.key} data-state={s.state} className="flex items-center gap-2.5 border-b border-zk-border-soft px-4 py-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0" style={{ background: c.cell }}>
            <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-[12px] font-bold" style={{ background: c.bg, color: c.fg, border: `1.5px solid ${c.bd}` }}>
              {s.state === "ok" ? "✓" : i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-zk-text">{s.name}</div>
              <div className="truncate text-[11.5px]" style={{ color: c.sub }}>
                {s.sub}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
