"use client";
// P2-WP-R3：雞頭首頁（README §25 桌面／§21 手機雞頭部分）。數據來自兩個
// 唯讀 API：`GET /api/dashboard/broker`（本月已排更數／待審批／自己保安
// 員／配額／逐盤明細——新增，見 src/lib/reports/broker-dashboard.ts）同
// `GET /api/reports/my-receivable`（本月應收金額，WP4 已有；雞頭隔離已
// 由嗰個 route 自己保證，呢度淨係讀 `total`）。兩個 API 都用
// session.brokerId 隔離，冇任何 query 參數可以睇第二個雞頭嘅數。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { tableCls, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtYearMonthZh, fmtMonthDayWeekday, greetingWord, todayLocalStr } from "@/lib/ui/format";

interface BrokerSiteRow {
  site_id: string;
  site_name: string;
  shifts: number;
  pending: number;
}
interface DashboardResult {
  month: string;
  scheduled_shifts: number;
  pending_approval_count: number;
  guard_count: number;
  quota: { target_shifts: number; scheduled_shifts: number } | null;
  sites: BrokerSiteRow[];
}
interface ReceivableResult {
  total: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface BrokerDashboardProps {
  userName: string;
}

export default function BrokerDashboard({ userName }: BrokerDashboardProps) {
  const router = useRouter();
  const [month] = useState(currentMonth);
  const [data, setData] = useState<DashboardResult | null>(null);
  const [receivable, setReceivable] = useState<ReceivableResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [dashRes, recvRes] = await Promise.all([
        apiGet<DashboardResult>(`/api/dashboard/broker?month=${month}`),
        apiGet<ReceivableResult>(`/api/reports/my-receivable?month=${month}`),
      ]);
      if (cancelled) return;
      if (!dashRes.ok) {
        setError(dashRes.message);
        setLoading(false);
        return;
      }
      setData(dashRes.data);
      if (recvRes.ok) setReceivable(recvRes.data);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [month]);

  if (error) return <Banner kind="error" message={error} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden md:block">
        <PageHeader kicker={`雞頭 · ${fmtYearMonthZh(month)}`} title={`歡迎返嚟，${userName}`} />
      </div>
      {/* 手機：同 README §21 共用嘅「問候」mobile home 頭（早晨/午安/晚安），
          唔重複桌面嘅「歡迎返嚟」字眼，避免同一段文字喺 DOM 出現兩次。 */}
      <div className="md:hidden">
        <div className="text-xs text-zk-muted">
          {fmtMonthDayWeekday(todayLocalStr())} · 雞頭
        </div>
        <div className="mt-0.5 text-[20px] font-bold text-zk-text">
          {greetingWord()}，{userName}
        </div>
      </div>

      {loading && !data ? (
        <div className="text-sm text-zk-faint">載入緊…</div>
      ) : data ? (
        <>
          {/* 桌面 4 KPI：README §25 `repeat(auto-fit,minmax(220px,1fr))`。 */}
          <div className="hidden grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 md:grid">
            <KpiCard
              label="本月已排更數"
              value={data.scheduled_shifts}
              href="/roster"
              note={`待審批 ${data.pending_approval_count} · ${data.guard_count} 位保安員`}
            />
            <KpiCard
              label="本月應收（出街價）"
              value={receivable ? fmtMoney(receivable.total) : "—"}
              href="/my-receivable"
              note={<span className="text-zk-primary">逐日明細 ›</span>}
            />
            <KpiCard
              label="配額"
              value={data.quota ? `${data.quota.scheduled_shifts}/${data.quota.target_shifts}` : "未設"}
              tone="default"
              href="/quotas"
              note={data.quota ? undefined : `${fmtYearMonthZh(month)} 冇配額限制`}
            />
            <KpiCard label="自己保安員" value={data.guard_count} href="/guards" note={<span className="text-zk-primary">名冊 ›</span>} />
          </div>

          {/* 手機 2×2 KPI（README §21 雞頭手機首頁）。 */}
          <div className="grid grid-cols-2 gap-2.5 md:hidden">
            <KpiCard label="本月已排" value={data.scheduled_shifts} href="/roster" note={`待審批 ${data.pending_approval_count}`} />
            <KpiCard label="本月應收" value={receivable ? fmtMoney(receivable.total) : "—"} href="/my-receivable" note={<span className="text-zk-primary">逐日明細 ›</span>} />
            <KpiCard label="配額" value={data.quota ? `${data.quota.scheduled_shifts}/${data.quota.target_shifts}` : "未設"} href="/quotas" />
            <KpiCard label="自己保安員" value={data.guard_count} href="/guards" />
          </div>

          {/* 「我有份嘅盤」——桌面表。 */}
          <div className="hidden flex-col gap-2 md:flex">
            <div className="text-sm font-semibold text-zk-text">我有份嘅盤</div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>盤</th>
                    <th className={tableCls.thNum}>本月更數</th>
                    <th className={tableCls.thNum}>待審批</th>
                    <th className={tableCls.thNum}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState title="呢個月未有份任何盤" description="未有排更記錄——喺配額或者更表度幫自己保安員開更先會出現喺呢度。" />
                      </td>
                    </tr>
                  )}
                  {data.sites.map((s) => (
                    <tr key={s.site_id} className={tableCls.rowHover}>
                      <td className={`${tableCls.td} font-medium`}>{s.site_name}</td>
                      <td className={tableCls.tdNum}>{s.shifts}</td>
                      <td className={tableCls.tdNum}>{s.pending > 0 ? s.pending : "—"}</td>
                      <td className={`${tableCls.td} text-right`}>
                        <button
                          type="button"
                          data-testid="broker-open-roster"
                          onClick={() => router.push(`/roster/${s.site_id}/${month}`)}
                          className="rounded-[5px] border border-zk-border px-[9px] py-[3px] text-xs text-zk-text-secondary transition-colors hover:bg-zk-header"
                        >
                          開更表
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 手機：「我有份嘅盤」列表卡。 */}
          <div className="flex flex-col gap-2 md:hidden">
            <div className="text-[13.5px] font-semibold text-zk-text">我有份嘅盤</div>
            <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
              {data.sites.length === 0 ? (
                <EmptyState title="呢個月未有份任何盤" />
              ) : (
                data.sites.map((s) => (
                  <Link
                    key={s.site_id}
                    href={`/roster/${s.site_id}/${month}`}
                    className="flex items-center gap-2.5 border-b border-[#f1f5f9] px-3.5 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-zk-text">{s.site_name}</div>
                    <div className="text-xs text-zk-muted">{s.shifts} 更</div>
                    <span className="text-zk-faint">›</span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
