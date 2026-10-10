"use client";
// P2-B：本月應收 client 部分（README §11）——3 stat 卡＋逐日明細表；
// 老闆／會計／主管（`isBroker=false`）可以用 `?broker=` 預覽某個雞頭
// （見 src/app/api/reports/my-receivable/route.ts）；雞頭 session 一律
// 淨係見自己，冇 broker select、冇預覽橫幅。URL `?broker=` 同步手法跟
// ShortfallDashboard.tsx 嘅 `?date=`／RosterEditor.tsx 嘅 `?broker=`
// 一致（`history.replaceState`，唔用 `useSearchParams()`避免 Suspense
// boundary）。
import { kickerFor } from "@/lib/nav/schema";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { P2BStatCard } from "@/components/ui/P2BStatCard";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtDate } from "@/lib/ui/format";
import { MonthPicker, useMonthState } from "@/components/ui/MonthPicker";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
// M4（Opus 驗收）：`grouped_days` 按 (日期, 盤, 更別, 出街價) 合併——一
// 條記錄一行改成「N 更 × 出街價 ＝ 金額」，`days`（逐 shift_record 一
// 行）保留喺 API response 但 UI 唔再直接用（避免行數 = 記錄數）。
interface GroupedRow {
  work_date: string;
  site_id: string;
  site_name: string;
  shift_type_code: string;
  outside_rate: number;
  shifts: number;
  amount: number;
}
interface UnpricedGroup {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  count: number;
}
interface Result {
  month: string;
  days: unknown[];
  grouped_days: GroupedRow[];
  total: number;
  total_shifts: number;
  pending_count: number;
  pending_amount: number;
  previewing: boolean;
  broker_code?: string;
  broker_name?: string;
  // WP-PRICE §3：additive——「N 更未定價，金額未計入」。
  unpriced_count?: number;
  unpriced_groups?: UnpricedGroup[];
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
  const [month, setMonth, monthReady] = useMonthState();
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  // M1（Opus 整合驗收）：initial state 唔可以喺 `useState` initializer
  // 度讀 `readBrokerFromUrl()`——SSR 冇 `window`，會令 SSR 輸出（空字串）
  // 同 CSR 首次 render（帶 URL 嘅 broker code）唔一致，觸發 hydration
  // error。改跟 `ShortfallDashboard.tsx` 嘅 `?date=` 做法：initial state
  // 一律用 SSR 一致嘅空字串，落面呢個 effect 先讀 URL。
  const [brokerParam, setBrokerParam] = useState<string>("");
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 預覽分支 403（例如日後老闆收走某角色嘅「出街價」權）——唔顯示通用
  // 紅色 Banner，改用專門嘅 Notice 講明係咩原因。
  const [forbiddenPreview, setForbiddenPreview] = useState(false);

  // 內部角色：入頁一次（mount）攞雞頭清單俾 select 用；URL 已經帶
  // `?broker=` 就即刻同步落 state（唔使等 fetch 完成），冇帶先等 fetch
  // 完用第一個做預設。呢個 effect 特登得 `[isBroker]` 一個 dep（唔可以
  // 加 `brokerParam`——會令用戶自己揀雞頭都觸發多一次冧晒嘅 broker
  // list fetch）。
  useEffect(() => {
    if (isBroker) return;
    const fromUrl = readBrokerFromUrl();
    if (fromUrl) setBrokerParam(fromUrl);
    (async () => {
      const res = await cachedGetAll<BrokerRow>("/api/brokers");
      if (!res.ok) return;
      setBrokers(res.data.rows);
      if (!fromUrl && res.data.rows.length > 0) {
        const first = res.data.rows[0]!.code;
        setBrokerParam(first);
        writeBrokerToUrl(first);
      }
    })();
  }, [isBroker]);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    if (!isBroker && !brokerParam) return; // 等雞頭清單攞完先 fetch
    let cancelled = false;
    (async () => {
      setLoading(true);
      const qs = new URLSearchParams({ month });
      if (!isBroker && brokerParam) qs.set("broker", brokerParam);
      const res = await apiGet<Result>(`/api/reports/my-receivable?${qs.toString()}`);
      if (cancelled) return;
      if (!res.ok) {
        setForbiddenPreview(!isBroker && res.status === 403);
        setError(res.status === 403 ? null : res.message);
        setLoading(false);
        return;
      }
      setForbiddenPreview(false);
      setData(res.data);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [month, brokerParam, isBroker, monthReady]);

  function changeBroker(next: string) {
    setBrokerParam(next);
    writeBrokerToUrl(next);
  }

  const previewLabel = data?.broker_code ? `${data.broker_code}${data.broker_name ? `（${data.broker_name}）` : ""}` : brokerParam;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={isBroker ? kickerFor("/my-receivable", true) : "資料"}
        title="本月應收"
        subtitle="自己保安員本月更數 × 自己出街價，逐日明細。"
        actions={
          <MonthPicker label="月份" value={month} onChange={setMonth} />
        }
      />

      {/* 冇「出街價」權限嘅內部角色——顯示專門嘅 warning Notice，唔顯示
          雞頭 select（揀咗都係照 403）。老闆 2026-09-15 拍板主管可以預覽。 */}
      {!isBroker && forbiddenPreview && <Banner compact kind="warning">你嘅角色暫時唔可以預覽雞頭應收——需要「出街價」權限，請聯絡老闆開放。</Banner>}

      {!isBroker && !forbiddenPreview && (
        <Banner compact
          kind="info"
          action={
            brokers.length > 0 && (
              <select
                data-testid="my-receivable-broker-select"
                className="rounded border-0 bg-transparent text-zk-sm font-semibold text-zk-primary-deep outline-none"
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
        </Banner>
      )}

      <Banner kind="error" message={error} />
      {/* WP-PRICE §3：頁頂「N 更未定價，金額未計入」——逐組列表。 */}
      {(data?.unpriced_count ?? 0) > 0 && (
        <Banner compact kind="warning">
          <p className="font-medium">呢個月有 {data!.unpriced_count} 更未定價（冇對應價目卡），金額未計入以上合計：</p>
          <ul className="list-disc pl-5 mt-1">
            {(data!.unpriced_groups ?? []).map((g) => (
              <li key={`${g.site_id}|${g.shift_type_code}|${g.broker_code ?? "none"}`}>
                {g.site_name} · 更別 {g.shift_type_code} · 雞頭 {g.broker_display} · {g.count} 更
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {!forbiddenPreview && <EmptyMonthNotice month={month} isEmpty={!loading && (data?.grouped_days.length ?? 0) === 0} onJump={setMonth} />}

      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <P2BStatCard label="本月更數" value={data.total_shifts} />
          <P2BStatCard label="合計（出街價）" value={fmtMoney(data.total)} />
          <P2BStatCard
            label="待審批"
            tone={data.pending_count > 0 ? "warning" : "default"}
            value={<span>{data.pending_count} 更</span>}
            note={data.pending_count > 0 ? <span style={{ color: "var(--zk-warning)" }}>{fmtMoney(data.pending_amount)}</span> : undefined}
          />
        </div>
      )}

      {/* 桌面表。 */}
      <div className="hidden lg:block">
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
              {!loading && (data?.grouped_days.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={COLS}>
                    <EmptyState title="呢個月暫時冇資料" description="呢個月未有排更記錄。" />
                  </td>
                </tr>
              )}
              {data?.grouped_days.map((g, i) => (
                <tr key={i} className={tableCls.rowHover} data-testid="my-receivable-row">
                  <td className={tableCls.td}>{fmtDate(g.work_date)}</td>
                  <td className={`${tableCls.td} font-medium`}>{g.site_name}</td>
                  <td className={tableCls.td}>{g.shift_type_code}</td>
                  <td className={tableCls.tdNum}>{g.shifts}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(g.outside_rate)}</td>
                  <td className={`${tableCls.tdNum} font-semibold`}>{fmtMoney(g.amount)}</td>
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
      <div className="flex flex-col gap-2 lg:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : (data?.grouped_days.length ?? 0) === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {data?.grouped_days.map((g, i) => (
              <div key={i} className="flex items-center justify-between gap-2.5 border-b border-zk-border-soft px-3.5 py-2.5 last:border-b-0" data-testid="my-receivable-row-mobile">
                <div className="min-w-0">
                  <div className="truncate text-zk-base font-medium text-zk-text">{g.site_name}</div>
                  <div className="mt-0.5 text-zk-xs text-zk-muted">
                    {fmtDate(g.work_date)} · {g.shift_type_code} · {g.shifts} × {fmtMoney(g.outside_rate)}
                  </div>
                </div>
                <div className="shrink-0 text-zk-base font-semibold text-zk-text">{fmtMoney(g.amount)}</div>
              </div>
            ))}
            {data && (
              <div className="flex items-center justify-between border-t border-zk-border bg-zk-header px-3.5 py-2.5 text-zk-base font-bold text-zk-text">
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
