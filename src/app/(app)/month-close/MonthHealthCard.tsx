"use client";
// WP-AI-OPS §28.3：鎖月前體檢卡——只提示，唔擋鎖月。顯示 critical／warn 數，
// 逐個 finding 可以展開明細（冇權限就只有數量）。
import { useEffect, useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { apiGet } from "@/lib/ui/api-client";

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

function sevPill(s: FindingDTO["severity"]) {
  if (s === "critical") return <Pill variant="danger">嚴重</Pill>;
  if (s === "warn") return <Pill variant="warning">留意</Pill>;
  return <Pill variant="neutral">補資料</Pill>;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join("、");
  return String(v);
}

export function MonthHealthCard({ month }: { month: string }) {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    setErr(null);
    apiGet<HealthDTO>(`/api/reports/month-health?month=${month}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setHealth(res.data);
      else setErr(res.message);
    });
    return () => {
      cancelled = true;
    };
  }, [month]);

  if (err) return null; // 冇權限／出錯都唔阻鎖月流程
  if (!health) return <div className="text-[12px] text-zk-faint">鎖月前體檢載入緊……</div>;

  return (
    <div className="rounded-md border border-zk-border bg-white p-3" data-testid="month-health-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-zk-text">鎖月前體檢（{health.month}）</div>
        <div className="flex items-center gap-1.5">
          <Pill variant={health.summary.critical > 0 ? "danger" : "success"}>嚴重 {health.summary.critical}</Pill>
          <Pill variant={health.summary.warn > 0 ? "warning" : "success"}>留意 {health.summary.warn}</Pill>
          <Pill variant="neutral">補資料 {health.summary.info}</Pill>
        </div>
      </div>
      <div className="mt-1 text-[11.5px] text-zk-faint">只係提示，唔會擋鎖月。{!health.has_prev && "（上月冇數據，唔做逐盤比較）"}</div>
      {health.findings.length === 0 && <div className="mt-2 text-[12.5px] text-green-700">冇發現問題。</div>}
      <ul className="mt-2 flex flex-col gap-1.5">
        {health.findings.map((f) => {
          const cols = f.detail && f.detail.length > 0 ? Object.keys(f.detail[0]!) : [];
          return (
            <li key={f.code} className="rounded border border-zk-border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[12.5px] text-zk-text">
                  {sevPill(f.severity)}
                  <span>{f.message}</span>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  <a href={f.fix_link} className="text-zk-primary underline">
                    去處理
                  </a>
                  {f.detail && f.detail.length > 0 && (
                    <button type="button" className="text-zk-muted underline" onClick={() => setOpen(open === f.code ? null : f.code)}>
                      {open === f.code ? "收埋" : "明細"}
                    </button>
                  )}
                </div>
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
    </div>
  );
}
