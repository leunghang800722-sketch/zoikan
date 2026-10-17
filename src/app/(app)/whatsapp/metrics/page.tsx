"use client";
// W5：WhatsApp 運維指標——近 7／30 日整體＋按群細分（只有數字，無原文）。手機 375px：每群一張卡，指標兩欄格。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/DataTable";
import { apiGet } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";

interface Metrics {
  received: number;
  filtered: number;
  parsed: number;
  auto_judged: number;
  auto_written: number;
  pending: number;
  approved: number;
  rejected: number;
  triage_opened: number;
  triage_answered: number;
  consistency_rate: number | null;
  llm_calls: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  errors: number;
}
interface GroupMetrics extends Metrics {
  group_id: string | null;
  label: string;
}
interface MetricsRes {
  days: number;
  from: string;
  to: string;
  totals: Metrics;
  groups: GroupMetrics[];
}

const FIELDS: Array<[keyof Metrics, string]> = [
  ["received", "收訊"],
  ["filtered", "過濾"],
  ["parsed", "解析"],
  ["auto_judged", "建議自動"],
  ["auto_written", "實際自動寫入"],
  ["pending", "待批"],
  ["approved", "已批核"],
  ["rejected", "退回"],
  ["triage_opened", "Triage 開題"],
  ["triage_answered", "Triage 已答"],
  ["consistency_rate", "對照一致率"],
  ["llm_calls", "AI 呼叫"],
  ["llm_tokens_in", "Token 入"],
  ["llm_tokens_out", "Token 出"],
  ["errors", "錯誤"],
];

function show(k: keyof Metrics, v: number | null): string {
  if (k === "consistency_rate") return v === null ? "—" : `${Math.round(v * 100)}%`;
  return String(v ?? 0);
}

function Grid({ m, testid }: { m: Metrics; testid: string }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-zk-sm sm:grid-cols-3 lg:grid-cols-5" data-testid={testid}>
      {FIELDS.map(([k, label]) => (
        <div key={k} data-metric={k}>
          <dt className="text-zk-xs text-zk-muted">{label}</dt>
          <dd className={`tabular-nums ${k === "errors" && m.errors > 0 ? "font-semibold text-zk-danger" : "text-zk-text"}`}>{show(k, m[k] as number | null)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function WhatsappMetricsPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricsRes | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await apiGet<MetricsRes>(`/api/whatsapp/metrics?days=${days}`);
    if (r.ok) setData(r.data);
    else setError(r.message);
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/whatsapp/metrics")}
        title="WhatsApp 報更指標"
        subtitle="運維用數字：收訊、解析、自動寫入、批核、分流、AI 用量同錯誤（只有數字，無原文）。"
        actions={
          <>
            <Link href="/whatsapp" className="rounded-md border border-zk-input-border bg-white px-3.5 py-[7px] text-zk-base text-zk-text-secondary transition-colors hover:bg-zk-header">返回 WhatsApp 報更</Link>
            <Button onClick={() => void load()}>重新整理</Button>
          </>
        }
      />
      <Banner kind="error" message={error} />
      <div className="flex gap-2" role="group" aria-label="期間">
        {[7, 30].map((d) => (
          <Button key={d} size="sm" variant={days === d ? "primary" : "secondary"} aria-pressed={days === d} onClick={() => setDays(d)}>近 {d} 日</Button>
        ))}
        {data && <span className="self-center text-zk-xs text-zk-muted">{data.from} 至 {data.to}</span>}
      </div>
      {!data ? (
        <div className="text-zk-sm text-zk-faint">載入緊…</div>
      ) : (
        <>
          <section aria-label="整體" className="rounded-lg border border-zk-border bg-white p-3.5">
            <div className="mb-2 text-zk-sm font-semibold text-zk-text">整體（近 {data.days} 日）</div>
            <Grid m={data.totals} testid="wa-metrics-totals" />
          </section>
          <section aria-label="按群" className="space-y-2">
            <div className="text-zk-sm font-semibold text-zk-text">按群細分（{data.groups.length}）</div>
            {data.groups.length === 0 ? (
              <div className="rounded-lg border border-zk-border bg-white">
                <EmptyState title="呢段期間冇群組活動" description="有群組收到訊息後會喺度出現。" />
              </div>
            ) : (
              <ul className="grid gap-2 lg:grid-cols-2" data-testid="wa-metrics-groups">
                {data.groups.map((g) => (
                  <li key={g.group_id ?? g.label} className="rounded-lg border border-zk-border bg-white p-3" data-testid="wa-metrics-group">
                    <div className="mb-2 truncate text-zk-base font-semibold text-zk-text">{g.label}</div>
                    <Grid m={g} testid="wa-metrics-group-grid" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
