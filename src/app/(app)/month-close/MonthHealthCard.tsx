"use client";
// WP-AI-OPS §28.3＋WP-MC-UI 1a：鎖月前體檢——只提示，唔擋鎖月。嚴重預設展開，留意／補資料 outline pill；
// 文字人話化（去咗 unmatched／ambiguous 英文）；同「要你睇」重複嘅標「＝ 要你睇 N 題」。
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { healthDupReviewCount, humanizeHealth, humanizeHealthCell, type ReviewGroup } from "@/components/month-close/derive";

interface FindingDTO {
  code: string;
  severity: "info" | "warn" | "critical";
  count: number;
  message: string;
  fix_link: string;
  detail: Array<Record<string, unknown>> | null;
  detail_truncated: boolean;
  detail_withheld?: boolean;
}
interface HealthDTO {
  month: string;
  has_prev: boolean;
  summary: { critical: number; warn: number; info: number; total: number };
  findings: FindingDTO[];
}

const COLUMN_LABELS: Record<string, string> = {
  name_zh: "姓名",
  staff_no: "工號",
  work_date: "日期",
  sites: "盤",
  site_name: "盤",
  shifts: "更數",
  shift_count: "更數",
  raw_code: "更種",
  rows: "重複行數",
  broker_code: "雞頭",
  shift_type_code: "更種",
  count: "數量",
  cells: "格數",
  permit_expiry: "許可證到期",
  shifts_after_expiry: "到期後更數",
  prev: "上月",
  cur: "本月",
  change_pct: "變幅 %",
  prev_margin_pct: "上月毛利率",
  cur_margin_pct: "本月毛利率",
  change_points: "變幅（點）",
  revenue: "收入",
  cost: "成本",
};

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => humanizeHealthCell(String(x))).join("、");
  return humanizeHealthCell(String(v));
}

type Tab = "critical" | "warn" | "info";
const TAB_LABEL: Record<Tab, string> = { critical: "嚴重", warn: "留意", info: "補資料" };

export function MonthHealthCard({ month, groups = [], onLoaded, onOpenTriage }: { month: string; groups?: ReviewGroup[]; onLoaded?: (s: { critical: number; warn: number; info: number }) => void; onOpenTriage?: () => void }) {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("critical");

  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    setErr(null);
    apiGet<HealthDTO>(`/api/reports/month-health?month=${month}`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setHealth(res.data);
        onLoaded?.({ critical: res.data.summary.critical, warn: res.data.summary.warn, info: res.data.summary.info });
      } else setErr(res.message);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  if (err) return null; // 冇權限／出錯都唔阻鎖月流程
  if (!health) return <div className="text-[12px] text-zk-faint">鎖月前體檢載入緊……</div>;

  const s = health.summary;
  const list = health.findings.filter((f) => f.severity === tab);
  const pillCls = (t: Tab, on: boolean) => {
    const base = "rounded-xl px-2.5 py-[3px] text-[11.5px] font-semibold border";
    if (t === "critical") return `${base} ${s.critical > 0 ? "border-[#dc2626] bg-[#dc2626] text-white" : "border-zk-border bg-white text-zk-muted"} ${on ? "ring-2 ring-[#fecaca]" : ""}`;
    if (t === "warn") return `${base} border-[#fed7aa] bg-white text-[#c2410c] ${on ? "ring-2 ring-[#fed7aa]" : ""}`;
    return `${base} border-zk-border bg-white text-[#475569] ${on ? "ring-2 ring-zk-border" : ""}`;
  };

  return (
    <div className="flex flex-col gap-2" data-testid="month-health-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] font-semibold text-zk-muted">鎖月前體檢（{health.month}）· 只係提示，唔會擋鎖月</span>
        <span className="ml-auto flex gap-1.5">
          {(["critical", "warn", "info"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={tab === t} className={pillCls(t, tab === t)} onClick={() => setTab(t)}>
              {TAB_LABEL[t]} {s[t]}
            </button>
          ))}
        </span>
      </div>
      {!health.has_prev && <div className="text-[11.5px] text-zk-faint">（上月冇數據，唔做逐盤比較）</div>}
      {health.findings.length === 0 && <div className="text-[12.5px] text-green-700">冇發現問題。</div>}
      {health.findings.length > 0 && list.length === 0 && <div className="text-[12.5px] text-zk-muted">呢一級冇項目。</div>}
      {list.length > 0 && (
        <ul className="overflow-hidden rounded-lg border border-zk-border">
          {list.map((f) => {
            const cols = f.detail && f.detail.length > 0 ? Object.keys(f.detail[0]!) : [];
            const dup = healthDupReviewCount(f.code, groups);
            const dot = f.severity === "critical" ? "#dc2626" : f.severity === "warn" ? "#f97316" : "#94a3b8";
            return (
              <li key={f.code} className="border-b border-zk-border-soft px-3 py-2 last:border-b-0" data-health={f.code}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: dot }} />
                  <span className="min-w-0 flex-1">{humanizeHealth(f.message)}</span>
                  {dup > 0 &&
                    (onOpenTriage ? (
                      <button type="button" onClick={onOpenTriage} className="whitespace-nowrap rounded-[10px] bg-[#ffedd5] px-2 py-0.5 text-[11px] text-[#c2410c]">
                        ＝ 要你睇 {dup} 題
                      </button>
                    ) : (
                      <span className="whitespace-nowrap rounded-[10px] bg-[#ffedd5] px-2 py-0.5 text-[11px] text-[#c2410c]">＝ 要你睇 {dup} 題</span>
                    ))}
                  {f.detail && f.detail.length > 0 && (
                    <button type="button" className="whitespace-nowrap text-[12px] text-zk-muted underline" onClick={() => setOpen(open === f.code ? null : f.code)}>
                      {open === f.code ? "收埋" : "明細"}
                    </button>
                  )}
                  <a href={f.fix_link} className="whitespace-nowrap text-[12px] text-zk-primary hover:underline">
                    去處理 ›
                  </a>
                </div>
                {f.detail_withheld && <div className="mt-1 text-[11.5px] text-zk-faint">冇權限睇明細，淨係顯示數量。</div>}
                {open === f.code && f.detail && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="min-w-full text-[11.5px]">
                      <thead>
                        <tr>
                          {cols.map((c) => (
                            <th key={c} className="px-2 py-1 text-left font-medium text-zk-muted">
                              {COLUMN_LABELS[c] ?? c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {f.detail.map((row, i) => (
                          <tr key={i} className="border-t border-zk-border">
                            {cols.map((c) => (
                              <td key={c} className="px-2 py-1">
                                {cell(row[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {f.detail_truncated && <div className="mt-1 text-[11px] text-zk-faint">只顯示頭 50 行。</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
