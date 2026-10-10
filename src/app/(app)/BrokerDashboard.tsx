"use client";
// P2-WP-R3：雞頭首頁（README §25 桌面／§21 手機雞頭部分）。數據來自兩個
// 唯讀 API：`GET /api/dashboard/broker`（本月已排更數／待審批／自己保安
// 員／配額／逐盤明細——新增，見 src/lib/reports/broker-dashboard.ts）同
// `GET /api/reports/my-receivable`（本月應收金額，WP4 已有；雞頭隔離已
// 由嗰個 route 自己保證，呢度淨係讀 `total`）。兩個 API 都用
// session.brokerId 隔離，冇任何 query 參數可以睇第二個雞頭嘅數。
//
// B8 驗收修正：加月份切換 chip（同老闆首頁 `ShortfallDashboard` 嘅日期
// chip 同款做法）——`?month=` 讀（一次性，載入時）／寫（撳 chip 即刻
// `history.replaceState`，同 `ShortfallDashboard` 嘅 `?date=` 一致手法）。
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { tableCls, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtYearMonthZh, fmtMonthDayWeekday, greetingWord, todayLocalStr, addMonthsStr } from "@/lib/ui/format";
import { useMonthState } from "@/components/ui/MonthPicker";

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

/** B8：月份切換 chip——同 `ShortfallDashboard` 嘅 `DateChip` 同款樣式，
 * 「‹ 2026 年 7 月 ›」。 */
function MonthChip({ month, onChange }: { month: string; onChange: (next: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[5px] text-zk-base text-zk-text-secondary">
      <button
        type="button"
        aria-label="上個月"
        data-testid="broker-month-prev"
        onClick={() => onChange(addMonthsStr(month, -1))}
        className="px-0.5 text-zk-faint hover:text-zk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary"
      >
        ‹
      </button>
      <span data-testid="broker-month-label">{fmtYearMonthZh(month)}</span>
      <button
        type="button"
        aria-label="下個月"
        data-testid="broker-month-next"
        onClick={() => onChange(addMonthsStr(month, 1))}
        className="px-0.5 text-zk-faint hover:text-zk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary"
      >
        ›
      </button>
    </div>
  );
}

export interface BrokerDashboardProps {
  userName: string;
}

export default function BrokerDashboard({ userName }: BrokerDashboardProps) {
  // P3-3.2：月份經 useMonthState（URL → sessionStorage → 本月）同全站共用。
  const [month, setMonth, monthReady] = useMonthState();
  const [data, setData] = useState<DashboardResult | null>(null);
  const [receivable, setReceivable] = useState<ReceivableResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
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
  }, [month, monthReady]);


  if (error) return <Banner kind="error" message={error} />;

  // B3 驗收修正：手機版原本冇任何可見 <h1>（桌面 <h1> 由 PageHeader
  // 出，成個 PageHeader 包喺 `hidden md:block` 度；手機淨係得一個
  // `<div>` 重複問候文字，等於手機頁面完全冇 heading）。改做「同一個
  // h1、兩邊都係 heading」：淨係一個 <h1> 元素，入面兩個 <span> 用
  // `md:hidden`／`hidden md:inline` 互相排斥。
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-4">
        <div>
          <div className="text-xs text-zk-muted md:text-zk-sm">
            <span className="md:hidden">{fmtMonthDayWeekday(todayLocalStr())} · 雞頭</span>
            <span className="hidden md:inline">{`雞頭 · ${fmtYearMonthZh(month)}`}</span>
          </div>
          <h1 className="mt-0.5 text-zk-xl font-bold text-zk-text md:text-zk-xl md:tracking-[-0.01em]">
            <span className="md:hidden">
              {greetingWord()}，{userName}
            </span>
            <span className="hidden md:inline">{`歡迎返嚟，${userName}`}</span>
          </h1>
        </div>
        <MonthChip month={month} onChange={setMonth} />
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
              // B4 驗收修正：「未設」原本跌返用 KpiCard 預設嘅
              // `text-zk-text`（黑色 30px），README 明寫呢個狀態要用灰色
              // `#94a3b8`——`value` 本身接受 ReactNode，用 <span> 包裹
              // 單獨畀返個灰色，唔使改 KpiCard（R1 共用元件）。
              value={data.quota ? `${data.quota.scheduled_shifts}/${data.quota.target_shifts}` : <span className="text-zk-faint">未設</span>}
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
            <KpiCard
              label="配額"
              value={data.quota ? `${data.quota.scheduled_shifts}/${data.quota.target_shifts}` : <span className="text-zk-faint">未設</span>}
              href="/quotas"
            />
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
                        {/* B7 驗收修正：「我有份嘅盤」而家＝assignment 聯集
                            有更次嘅盤，真係全空即係「呢個月完全未指派任何
                            盤，亦未有排更記錄」。 */}
                        <EmptyState title="呢個月未有份任何盤" description="呢個月未指派任何盤，亦未有排更記錄——請聯絡老闆／主管指派盤，或者喺配額／更表開更。" />
                      </td>
                    </tr>
                  )}
                  {data.sites.map((s) => (
                    <tr key={s.site_id} className={tableCls.rowHover}>
                      <td className={`${tableCls.td} font-medium`}>{s.site_name}</td>
                      <td className={tableCls.tdNum}>{s.shifts}</td>
                      <td className={tableCls.tdNum}>{s.pending > 0 ? s.pending : "—"}</td>
                      <td className={`${tableCls.td} text-right`}>
                        {/* B1 驗收修正：原本 `<button onClick={() =>
                            router.push(...)}>`——雖然本身已經係真
                            `<button>`（可 Tab 到），但呢個操作本質係
                            純導航，改用 `next/link` 更啱語意（右鍵可以
                            開新分頁／中鍵開新視窗），並加明確
                            focus-visible 樣式。 */}
                        <Link
                          href={`/roster/${s.site_id}/${month}`}
                          data-testid="broker-open-roster"
                          className="inline-block rounded-[5px] border border-zk-border px-[9px] py-[3px] text-xs text-zk-text-secondary transition-colors hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary"
                        >
                          開更表
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 手機：「我有份嘅盤」列表卡。 */}
          <div className="flex flex-col gap-2 md:hidden">
            <div className="text-zk-base font-semibold text-zk-text">我有份嘅盤</div>
            <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
              {data.sites.length === 0 ? (
                <EmptyState title="呢個月未有份任何盤" description="呢個月未指派任何盤，亦未有排更記錄。" />
              ) : (
                data.sites.map((s) => (
                  <Link
                    key={s.site_id}
                    href={`/roster/${s.site_id}/${month}`}
                    className="flex items-center gap-2.5 border-b border-zk-border-soft px-3.5 py-3 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zk-primary"
                  >
                    <div className="min-w-0 flex-1 truncate text-zk-base font-medium text-zk-text">{s.site_name}</div>
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
