"use client";
// P2-B：毛利即時表（README §12）——3 stat 卡（全公司毛利率／低於門檻嘅盤
// 紅／額外盤 灰）＋逐盤×更別表，<門檻 整行紅底。
//
// 行為決定（同 gross-margin-empty-month／wp4.spec.ts (a) 呢類舊 e2e／
// unit test 一致，冇改）：撳行＝展開／收埋嗰盤嘅更別 breakdown（保留 P1
// 原有行為），唔改做直接跳去更表——README「撳行開該盤更表」改用行內
// 「更表 ›」連結做（唔覆蓋原有展開行為，兩個唔衝突）。
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { P2BStatCard } from "@/components/ui/P2BStatCard";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";
import { MonthPicker, useMonthState } from "@/components/ui/MonthPicker";

// API response 一律 snake_case（見 src/lib/api/http.ts 嘅 ok()/
// camelToSnakeDeep()）——呢啲 interface 要同 wire format 一致，唔係
// src/lib/reports/gross-margin.ts 個 TS type 個 camelCase 名。
interface ShiftTypeRow {
  shift_type_id: string | null;
  code: string;
  label: string | null;
  kind: string;
  shifts: number;
  ot_hours: number | null;
  revenue?: number;
  cost?: number;
  profit?: number;
  note: string | null;
}
interface SiteRow {
  site_id: string;
  site_name: string;
  billing_model: string;
  is_monthly_fee: boolean;
  in_p0_monthly_close: boolean;
  shift_types: ShiftTypeRow[];
  referral_fee?: number;
  longterm_salary_allocated?: number;
  missing_salary_guard_refs?: string[];
  shifts: number;
  revenue?: number;
  cost?: number;
  profit?: number;
  margin_pct?: number | null;
  below_threshold?: boolean;
  note: string | null;
}
interface UnpricedGroup {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  // 應修 1：同 RosterEditor.tsx 一致——`no_settlement`（冇結算單位）唔係
  // 「未定價」，唔可以喺同一個清單重複顯示，要獨立 filter 出嚟。
  category?: "payout_unpriced" | "client_unpriced" | "no_settlement";
  count: number;
}
interface Result {
  month: string;
  threshold_pct: number;
  sites: SiteRow[];
  totals: { shifts: number; revenue?: number; cost?: number; profit?: number; margin_pct?: number | null };
  unpriced_count?: number;
  unpriced_groups?: UnpricedGroup[];
  // 應修 1：獨立於「未定價」——settlement_broker_id IS NULL 嘅格喺毛利表
  // 都會完全消失，要有自己嘅警告，就算未定價 count＝0 都要顯示。
  no_settlement_count?: number;
}

const COLS = 7; // 盤/更數/營業額/成本/毛利/毛利率/備註

type SiteFilter = "all" | "in_close" | "outside";

// 應修③：毛利率由低到高排（null——冇 revenue 計唔到率——排最尾），紅底
// 行（<門檻）自然排喺前面。
function sortByMarginAsc(sites: SiteRow[]): SiteRow[] {
  return [...sites].sort((a, b) => {
    const am = a.margin_pct;
    const bm = b.margin_pct;
    if (am == null && bm == null) return 0;
    if (am == null) return 1;
    if (bm == null) return -1;
    return am - bm;
  });
}

export default function GrossMarginPage() {
  const [month, setMonth, monthReady] = useMonthState(undefined, { persistDefault: true });
  const [data, setData] = useState<Result | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SiteFilter>("all");

  async function load() {
    setLoading(true);
    setError(null);
    const res = await apiGet<Result>(`/api/reports/gross-margin?month=${month}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setData(res.data);
    setLoading(false);
  }

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, monthReady]);

  function toggle(siteId: string) {
    setExpanded((e) => ({ ...e, [siteId]: !e[siteId] }));
  }

  const belowCount = data?.sites.filter((s) => s.below_threshold).length ?? 0;
  const extraCount = data?.sites.filter((s) => !s.in_p0_monthly_close).length ?? 0;

  // 應修③：頁首「只睇：全部盤／月結盤／額外盤」FilterChip；④：排序由低
  // 到高（null 排最尾）。
  const visibleSites = useMemo(() => {
    const sites = data?.sites ?? [];
    const filtered = filter === "in_close" ? sites.filter((s) => s.in_p0_monthly_close) : filter === "outside" ? sites.filter((s) => !s.in_p0_monthly_close) : sites;
    return sortByMarginAsc(filtered);
  }, [data, filter]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/reports/gross-margin")}
        title="毛利即時表"
        subtitle={`每盤×更別，本月至今更數／營業額／成本／毛利／毛利率。毛利率低於 ${data?.threshold_pct ?? 8}% 標紅。`}
        actions={
          <>
            <FilterChip label="只睇">
              <select value={filter} onChange={(e) => setFilter(e.target.value as SiteFilter)}>
                <option value="all">全部盤</option>
                <option value="in_close">月結盤</option>
                <option value="outside">額外盤</option>
              </select>
            </FilterChip>
            <MonthPicker label="月份" value={month} onChange={setMonth} />
            <a href={`/api/reports/gross-margin?month=${month}&export=1`}>
              <Button variant="secondary">匯出 Excel</Button>
            </a>
          </>
        }
      />

      <Banner kind="error" message={error} />
      {/* WP-PRICE §3：頁頂「N 更未定價，金額未計入」——逐組列表。 */}
      {(data?.unpriced_count ?? 0) > 0 && (
        <Banner compact kind="warning">
          <p className="font-medium">呢個月有 {data!.unpriced_count} 更未定價（冇對應價目卡），金額未計入毛利表：</p>
          <ul className="list-disc pl-5 mt-1">
            {/* 應修 1：no_settlement 分類唔喺呢個清單顯示（有自己獨立、更
                搶眼嘅 Notice，見下面）。 */}
            {(data!.unpriced_groups ?? [])
              .filter((g) => g.category !== "no_settlement")
              .map((g) => (
                <li key={`${g.category ?? "payout_unpriced"}|${g.site_id}|${g.shift_type_code}|${g.broker_code ?? "none"}`}>
                  {g.site_name} · 更別 {g.shift_type_code} · 雞頭 {g.broker_display} · {g.count} 更
                </li>
              ))}
          </ul>
        </Banner>
      )}
      {/* 應修 1：冇結算單位（settlement_broker_id NULL）嘅格——呢批更
          唔會計入任何雞頭／長工／公司兵嘅糧單，只會出現喺「未歸屬結算
          單位」行。就算未定價 count＝0 都要顯示。 */}
      {(data?.no_settlement_count ?? 0) > 0 && (
        <Banner compact kind="error">
          <p className="font-medium">
            呢個月有 {data!.no_settlement_count} 格冇結算單位（唔會計入任何雞頭／長工／公司兵嘅糧單，只會出現喺「未歸屬結算單位」行）：
          </p>
          <ul className="list-disc pl-5 mt-1">
            {(data!.unpriced_groups ?? [])
              .filter((g) => g.category === "no_settlement")
              .map((g) => (
                <li key={`no_settlement|${g.site_id}|${g.shift_type_code}`}>
                  {g.site_name} · 更別 {g.shift_type_code} · {g.count} 更
                </li>
              ))}
          </ul>
        </Banner>
      )}
      {/* A5：當月零資料先顯示，撳「去 YYYY-MM」即刻跳去最近有資料嘅月份。 */}
      <EmptyMonthNotice month={month} isEmpty={!loading && (data?.sites.length ?? 0) === 0} onJump={setMonth} />

      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <P2BStatCard label="全公司毛利率" value={data.totals.margin_pct == null ? "—" : `${data.totals.margin_pct}%`} />
          <P2BStatCard label={`低於 ${data.threshold_pct}% 嘅盤`} value={belowCount} tone={belowCount > 0 ? "danger" : "default"} />
          <P2BStatCard label="額外盤（未收入基準）" value={<span className="text-zk-muted">{extraCount}</span>} />
        </div>
      )}

      {/* 桌面表（撳行展開更別 breakdown；手機改用下面嘅卡列表）。 */}
      <div className={`hidden lg:block ${tableCls.wrap}`}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(COLS) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>盤</th>
              <th className={tableCls.thNum}>更數</th>
              <th className={tableCls.thNum}>營業額</th>
              <th className={tableCls.thNum}>成本</th>
              <th className={tableCls.thNum}>毛利</th>
              <th className={tableCls.thNum}>毛利率</th>
              <th className={tableCls.th}>備註</th>
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
            {!loading && visibleSites.length === 0 && (
              <tr>
                <td colSpan={COLS}>
                  <EmptyState title="呢個月暫時冇資料" />
                </td>
              </tr>
            )}
            {visibleSites.map((s) => (
              <Fragment key={s.site_id}>
                <tr
                  data-testid="gross-margin-row"
                  className={`cursor-pointer ${tableCls.rowHover} ${s.below_threshold ? tableCls.warnRow : ""}`}
                  onClick={() => toggle(s.site_id)}
                >
                  <td className={`${tableCls.td} font-medium`}>
                    <span className="text-zk-faint">{expanded[s.site_id] ? "▾" : "▸"}</span> {s.site_name}
                    {s.is_monthly_fee && <span className="ml-1 text-xs text-zk-faint">（月費盤）</span>}
                    <Link
                      href={`/roster/${s.site_id}/${month}`}
                      onClick={(e) => e.stopPropagation()}
                      className="ml-2 text-xs text-zk-primary hover:underline"
                    >
                      更表 ›
                    </Link>
                  </td>
                  <td className={tableCls.tdNum}>{s.shifts}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(s.revenue)}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(s.cost)}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(s.profit)}</td>
                  <td className={s.below_threshold ? "border-b border-zk-border-soft px-3.5 py-2.5 text-right font-bold text-zk-danger" : tableCls.tdNum}>
                    {s.margin_pct == null ? "—" : `${s.margin_pct}%`}
                  </td>
                  <td className={tableCls.tdMuted}>{s.note ?? (s.is_monthly_fee ? "月費盤 · 更數越多毛利越低" : "")}</td>
                </tr>
                {expanded[s.site_id] &&
                  s.shift_types.map((st, i) => (
                    <tr key={`${s.site_id}-${i}`} className="border-b border-zk-border-soft bg-zk-header/50 text-xs text-zk-muted">
                      <td className="px-3.5 py-1.5 pl-9">
                        {st.code}
                        {st.label ? `（${st.label}）` : ""}
                      </td>
                      <td className="px-3.5 py-1.5 text-right">
                        {st.shifts}
                        {st.ot_hours ? ` (${st.ot_hours}h)` : ""}
                      </td>
                      <td className="px-3.5 py-1.5 text-right">{fmtMoney(st.revenue)}</td>
                      <td className="px-3.5 py-1.5 text-right">{fmtMoney(st.cost)}</td>
                      <td className="px-3.5 py-1.5 text-right">{fmtMoney(st.profit)}</td>
                      <td></td>
                      <td className="px-3.5 py-1.5">{st.note}</td>
                    </tr>
                  ))}
                {expanded[s.site_id] && ((s.referral_fee ?? 0) > 0 || (s.longterm_salary_allocated ?? 0) > 0) && (
                  <tr className="border-b border-zk-border-soft bg-zk-header/50 text-xs text-zk-muted">
                    <td className="px-3.5 py-1.5 pl-9">長工雞頭費 / 長工月薪分攤</td>
                    <td></td>
                    <td></td>
                    <td className="px-3.5 py-1.5 text-right">{fmtMoney((s.referral_fee ?? 0) + (s.longterm_salary_allocated ?? 0))}</td>
                    <td colSpan={3}></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {data && (
            <tfoot>
              <tr>
                <td className={`${tableCls.td} ${tableCls.foot}`}>全公司合計</td>
                <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{data.totals.shifts}</td>
                <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(data.totals.revenue)}</td>
                <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(data.totals.cost)}</td>
                <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(data.totals.profit)}</td>
                <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{data.totals.margin_pct == null ? "—" : `${data.totals.margin_pct}%`}</td>
                <td className={tableCls.foot}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* 手機：每行變卡（簡化——冇更別 breakdown，撳卡直接去更表）。 */}
      <div className="flex flex-col gap-2 lg:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : visibleSites.length === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          visibleSites.map((s) => (
            <Link
              key={s.site_id}
              href={`/roster/${s.site_id}/${month}`}
              data-testid="gross-margin-row-mobile"
              className={`flex flex-col gap-1 rounded-[10px] border border-zk-border px-3.5 py-3 ${s.below_threshold ? "bg-zk-danger-bg" : "bg-white"}`}
            >
              <div className="flex items-center justify-between">
                <div className="truncate text-zk-base font-medium text-zk-text">{s.site_name}</div>
                <div className={`text-zk-base font-bold ${s.below_threshold ? "text-zk-danger" : "text-zk-text"}`}>{s.margin_pct == null ? "—" : `${s.margin_pct}%`}</div>
              </div>
              <div className="text-zk-xs text-zk-muted">
                {s.shifts} 更 · 毛利 {fmtMoney(s.profit)} / 營業額 {fmtMoney(s.revenue)}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
