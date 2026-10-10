"use client";
// P2.5「現場反映」開會模式——「現場意見」清單（老闆）。同
// `audit-log/page.tsx` 一樣版面模式：`PageHeader` kicker「系統」、filter
// chip（狀態）、`tableCls` 列表；手機每行變卡（README 手機外殼模式）。
import { useEffect, useState } from "react";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { GuardedLink } from "@/components/ui/GuardedLink";
import { fmtDateTime } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

interface FeedbackReportRow {
  id: string;
  title: string;
  role_name: string;
  status: "new" | "read" | "forwarded" | "declined";
  created_at: string;
}

const STATUS_OPTIONS = [
  { value: "", label: "全部" },
  { value: "new", label: "新" },
  { value: "read", label: "已睇" },
  { value: "forwarded", label: "已轉交" },
  { value: "declined", label: "唔做" },
] as const;

function statusPill(status: FeedbackReportRow["status"]) {
  if (status === "new") return <Pill variant="warning">新</Pill>;
  if (status === "forwarded") return <Pill variant="success">已轉交</Pill>;
  if (status === "declined") return <Pill variant="neutral">唔做</Pill>;
  return <Pill variant="neutral">已睇</Pill>;
}

const PAGE_SIZE = 50;

export function FeedbackPageClient() {
  const [rows, setRows] = useState<FeedbackReportRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: "0" });
      if (status) qs.set("status", status);
      const res = await apiGet<ApiListResult<FeedbackReportRow>>(`/api/feedback/reports?${qs.toString()}`);
      if (cancelled) return;
      if (res.ok) setRows(res.data.rows);
      else setError(res.message);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [status]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/feedback")}
        title="現場意見"
        subtitle="主管／會計／老闆用「開會反映」送出嘅現場改動訴求——只讀清單，未評估可行性。"
        actions={
          <FilterChip label="狀態">
            <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="feedback-status-filter">
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FilterChip>
        }
      />

      {error && <div className="rounded border border-zk-danger-border bg-zk-danger-bg px-3 py-2 text-xs text-zk-danger-dark">{error}</div>}

      {/* 桌面：表；手機：卡（README 手機外殼模式，唔靠 CSS 縮表）。 */}
      <div className={`${tableCls.wrap} hidden sm:block`} data-testid="feedback-table">
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>日期</th>
              <th className={tableCls.th}>角色</th>
              <th className={tableCls.th}>標題</th>
              <th className={tableCls.th}>狀態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`${tableCls.rowHover} cursor-pointer`}>
                <td className={tableCls.td} colSpan={4} style={{ padding: 0 }}>
                  <GuardedLink href={`/feedback/${r.id}`} className="flex w-full items-center gap-3 px-3.5 py-2.5" data-testid="feedback-row">
                    <span className={`w-[150px] shrink-0 ${tableCls.tdMuted}`} style={{ border: "none", padding: 0 }}>
                      {fmtDateTime(r.created_at)}
                    </span>
                    <span className="w-[80px] shrink-0 text-zk-text-secondary">{r.role_name}</span>
                    <span className="flex-1 truncate font-medium text-zk-text">{r.title}</span>
                    <span className="shrink-0">{statusPill(r.status)}</span>
                  </GuardedLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <EmptyState title="未有現場意見" description="主管／會計／老闆用側欄「開會反映」送出之後會出現喺呢度。" />}
      </div>

      <div className="flex flex-col gap-2 sm:hidden">
        {rows.map((r) => (
          <GuardedLink
            key={r.id}
            href={`/feedback/${r.id}`}
            data-testid="feedback-card"
            className="flex flex-col gap-1.5 rounded-lg border border-zk-border bg-white px-3.5 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-zk-xs text-zk-muted">{fmtDateTime(r.created_at)}</span>
              {statusPill(r.status)}
            </div>
            <div className="text-zk-base font-semibold text-zk-text">{r.title}</div>
            <div className="text-zk-xs text-zk-muted">{r.role_name}</div>
          </GuardedLink>
        ))}
        {!loading && rows.length === 0 && <EmptyState title="未有現場意見" description="主管／會計／老闆用側欄「開會反映」送出之後會出現喺呢度。" />}
      </div>
    </div>
  );
}
