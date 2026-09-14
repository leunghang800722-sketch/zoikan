"use client";
// P2-B：毛利即時表（README §12）——3 stat 卡（全公司毛利率／低於門檻嘅盤
// 紅／額外盤 灰）＋逐盤×更別表，<門檻 整行紅底。
//
// 行為決定（同 gross-margin-empty-month／wp4.spec.ts (a) 呢類舊 e2e／
// unit test 一致，冇改）：撳行＝展開／收埋嗰盤嘅更別 breakdown（保留 P1
// 原有行為），唔改做直接跳去更表——README「撳行開該盤更表」改用行內
// 「更表 ›」連結做（唔覆蓋原有展開行為，兩個唔衝突）。
import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { KpiCard } from "@/components/ui/KpiCard";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, currentMonthStr } from "@/lib/ui/format";

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
interface Result {
  month: string;
  threshold_pct: number;
  sites: SiteRow[];
  totals: { shifts: number; revenue?: number; cost?: number; profit?: number; margin_pct?: number | null };
}

const COLS = 7; // 盤/更數/營業額/成本/毛利/毛利率/備註

export default function GrossMarginPage() {
  const [month, setMonth] = useState(() => currentMonthStr());
  const [data, setData] = useState<Result | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  function toggle(siteId: string) {
    setExpanded((e) => ({ ...e, [siteId]: !e[siteId] }));
  }

  const belowCount = data?.sites.filter((s) => s.below_threshold).length ?? 0;
  const extraCount = data?.sites.filter((s) => !s.in_p0_monthly_close).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="財務"
        title="毛利即時表"
        subtitle={`每盤×更別，本月至今更數／營業額／成本／毛利／毛利率。毛利率低於 ${data?.threshold_pct ?? 8}% 標紅。`}
        actions={
          <>
            <FilterChip label="月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <a href={`/api/reports/gross-margin?month=${month}&export=1`}>
              <Button variant="secondary">匯出 Excel</Button>
            </a>
          </>
        }
      />

      <Banner kind="error" message={error} />

      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="全公司毛利率" value={data.totals.margin_pct == null ? "—" : `${data.totals.margin_pct}%`} />
          <KpiCard label="低於門檻嘅盤" value={<span style={{ color: belowCount > 0 ? "#dc2626" : undefined }}>{belowCount}</span>} tone={belowCount > 0 ? "danger" : "default"} />
          <KpiCard label="額外盤" value={<span className="text-zk-muted">{extraCount}</span>} />
        </div>
      )}

      {/* 桌面表（撳行展開更別 breakdown；手機改用下面嘅卡列表）。 */}
      <div className={`hidden md:block ${tableCls.wrap}`}>
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
            {!loading && data?.sites.length === 0 && (
              <tr>
                <td colSpan={COLS}>
                  <EmptyState title="呢個月暫時冇資料" />
                </td>
              </tr>
            )}
            {data?.sites.map((s) => (
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
                  <td className={s.below_threshold ? "border-b border-[#f1f5f9] px-3.5 py-2.5 text-right font-bold text-[#dc2626]" : tableCls.tdNum}>
                    {s.margin_pct == null ? "—" : `${s.margin_pct}%`}
                  </td>
                  <td className={tableCls.tdMuted}>{s.note ?? (s.is_monthly_fee ? "更數越多毛利越低" : "")}</td>
                </tr>
                {expanded[s.site_id] &&
                  s.shift_types.map((st, i) => (
                    <tr key={`${s.site_id}-${i}`} className="border-b border-[#f1f5f9] bg-zk-header/50 text-xs text-zk-muted">
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
                  <tr className="border-b border-[#f1f5f9] bg-zk-header/50 text-xs text-zk-muted">
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
      <div className="flex flex-col gap-2 md:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : (data?.sites.length ?? 0) === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          data?.sites.map((s) => (
            <Link
              key={s.site_id}
              href={`/roster/${s.site_id}/${month}`}
              data-testid="gross-margin-row-mobile"
              className={`flex flex-col gap-1 rounded-[10px] border border-zk-border px-3.5 py-3 ${s.below_threshold ? "bg-[#fef2f2]" : "bg-white"}`}
            >
              <div className="flex items-center justify-between">
                <div className="truncate text-[13.5px] font-medium text-zk-text">{s.site_name}</div>
                <div className={`text-[13px] font-bold ${s.below_threshold ? "text-[#dc2626]" : "text-zk-text"}`}>{s.margin_pct == null ? "—" : `${s.margin_pct}%`}</div>
              </div>
              <div className="text-[11.5px] text-zk-muted">
                {s.shifts} 更 · 毛利 {fmtMoney(s.profit)} / 營業額 {fmtMoney(s.revenue)}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
