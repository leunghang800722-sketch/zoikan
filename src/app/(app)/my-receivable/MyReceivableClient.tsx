"use client";
// P2-B：本月應收 client 部分（README §11）——3 stat 卡＋逐日明細表；
// 老闆／會計／主管（`isBroker=false`）可以用 `?broker=` 預覽某個雞頭
// （見 src/app/api/reports/my-receivable/route.ts）；雞頭 session 一律
// 淨係見自己，冇 broker select、冇預覽橫幅。URL `?broker=` 同步手法跟
// ShortfallDashboard.tsx 嘅 `?date=`／RosterEditor.tsx 嘅 `?broker=`
// 一致（`history.replaceState`，唔用 `useSearchParams()`避免 Suspense
// boundary）。
import { useEffect, useState } from "react";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { KpiCard } from "@/components/ui/KpiCard";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtDate, currentMonthStr } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface DayRow {
  work_date: string;
  site_id: string;
  site_name: string;
  shift_type_code: string;
  amount: number;
}
interface Result {
  month: string;
  days: DayRow[];
  total: number;
  total_shifts: number;
  pending_count: number;
  pending_amount: number;
  previewing: boolean;
  broker_code?: string;
  broker_name?: string;
}
interface BrokerRow {
  id: string;
  code: string;
  name: string;
}

function readBrokerFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("broker");
}
function writeBrokerToUrl(broker: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("broker", broker);
  window.history.replaceState(null, "", url.toString());
}

const COLS = 6; // 日期／盤／更別／更數／出街價／金額

export function MyReceivableClient({ isBroker, roleLabel }: { isBroker: boolean; roleLabel: string }) {
  const [month, setMonth] = useState(() => currentMonthStr());
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [brokerParam, setBrokerParam] = useState<string>(() => (isBroker ? "" : (readBrokerFromUrl() ?? "")));
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 內部角色先要攞雞頭清單俾 select 用；未帶 ?broker= 就預設第一個。
  useEffect(() => {
    if (isBroker) return;
    (async () => {
      const res = await apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500");
      if (!res.ok) return;
      setBrokers(res.data.rows);
      if (!brokerParam && res.data.rows.length > 0) {
        const first = res.data.rows[0]!.code;
        setBrokerParam(first);
        writeBrokerToUrl(first);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBroker]);

  useEffect(() => {
    if (!isBroker && !brokerParam) return; // 等雞頭清單攞完先 fetch
    let cancelled = false;
    (async () => {
      setLoading(true);
      const qs = new URLSearchParams({ month });
      if (!isBroker && brokerParam) qs.set("broker", brokerParam);
      const res = await apiGet<Result>(`/api/reports/my-receivable?${qs.toString()}`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setData(res.data);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [month, brokerParam, isBroker]);

  function changeBroker(next: string) {
    setBrokerParam(next);
    writeBrokerToUrl(next);
  }

  const previewLabel = data?.broker_code ? `${data.broker_code}${data.broker_name ? `（${data.broker_name}）` : ""}` : brokerParam;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={isBroker ? "我的" : "財務"}
        title="本月應收"
        subtitle="自己保安員本月更數 × 自己出街價，逐日明細。"
        actions={
          <FilterChip label="月份">
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </FilterChip>
        }
      />

      {!isBroker && (
        <Notice
          variant="info"
          action={
            brokers.length > 0 && (
              <select
                data-testid="my-receivable-broker-select"
                className="rounded border-0 bg-transparent text-[12.5px] font-semibold text-[#1e40af] outline-none"
                value={brokerParam}
                onChange={(e) => changeBroker(e.target.value)}
              >
                {brokers.map((b) => (
                  <option key={b.id} value={b.code}>
                    {b.code}（{b.name}）
                  </option>
                ))}
              </select>
            )
          }
        >
          呢頁淨係俾雞頭角色用 — 你而家以{roleLabel}身份預覽{previewLabel ? ` ${previewLabel} ` : "（未揀雞頭）"}嘅數。
        </Notice>
      )}

      <Banner kind="error" message={error} />

      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="本月更數" value={data.total_shifts} />
          <KpiCard label="合計（出街價）" value={fmtMoney(data.total)} />
          <KpiCard
            label="待審批"
            value={<span style={{ color: "#c2410c" }}>{data.pending_count} 更</span>}
            note={data.pending_count > 0 ? <span style={{ color: "#c2410c" }}>{fmtMoney(data.pending_amount)}</span> : undefined}
          />
        </div>
      )}

      {/* 桌面表。 */}
      <div className="hidden md:block">
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(COLS) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>日期</th>
                <th className={tableCls.th}>盤</th>
                <th className={tableCls.th}>更別</th>
                <th className={tableCls.thNum}>更數</th>
                <th className={tableCls.thNum}>出街價</th>
                <th className={tableCls.thNum}>金額</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={COLS} className="px-3.5 py-4 text-sm text-zk-faint">
                    載入緊…
                  </td>
                </tr>
              )}
              {!loading && (data?.days.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={COLS}>
                    <EmptyState title="呢個月暫時冇資料" description="呢個月未有排更記錄。" />
                  </td>
                </tr>
              )}
              {data?.days.map((d, i) => (
                <tr key={i} className={tableCls.rowHover}>
                  <td className={tableCls.td}>{fmtDate(d.work_date)}</td>
                  <td className={`${tableCls.td} font-medium`}>{d.site_name}</td>
                  <td className={tableCls.td}>{d.shift_type_code}</td>
                  <td className={tableCls.tdNum}>1</td>
                  <td className={tableCls.tdNum}>{fmtMoney(d.amount)}</td>
                  <td className={`${tableCls.tdNum} font-semibold`}>{fmtMoney(d.amount)}</td>
                </tr>
              ))}
            </tbody>
            {data && (
              <tfoot>
                <tr>
                  <td className={`${tableCls.td} ${tableCls.foot}`} colSpan={3}>
                    合計
                  </td>
                  <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{data.total_shifts}</td>
                  <td className={`${tableCls.tdNum} ${tableCls.foot}`}></td>
                  <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(data.total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* 手機：每行變卡。 */}
      <div className="flex flex-col gap-2 md:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : (data?.days.length ?? 0) === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {data?.days.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-2.5 border-b border-[#f1f5f9] px-3.5 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-zk-text">{d.site_name}</div>
                  <div className="mt-0.5 text-[11.5px] text-zk-muted">
                    {fmtDate(d.work_date)} · {d.shift_type_code}
                  </div>
                </div>
                <div className="shrink-0 text-[13px] font-semibold text-zk-text">{fmtMoney(d.amount)}</div>
              </div>
            ))}
            {data && (
              <div className="flex items-center justify-between border-t border-zk-border bg-zk-header px-3.5 py-2.5 text-[13px] font-bold text-zk-text">
                <span>合計 {data.total_shifts} 更</span>
                <span>{fmtMoney(data.total)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
