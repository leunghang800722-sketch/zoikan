"use client";
import { Fragment, useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { fmtMoney } from "@/lib/ui/format";

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

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function GrossMarginPage() {
  const [month, setMonth] = useState(currentMonth());
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">毛利即時表</h1>
          <p className="text-sm text-gray-500">每盤×更別，本月至今更數／營業額／成本／毛利／毛利率。毛利率低於 {data?.threshold_pct ?? 8}% 標紅。</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" className="rounded border border-gray-300 px-2 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
          <a href={`/api/reports/gross-margin?month=${month}&export=1`} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            匯出 Excel
          </a>
        </div>
      </div>

      <Banner kind="error" message={error} />

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">盤</th>
              <th className="px-3 py-2 text-right">更數</th>
              <th className="px-3 py-2 text-right">營業額</th>
              <th className="px-3 py-2 text-right">成本</th>
              <th className="px-3 py-2 text-right">毛利</th>
              <th className="px-3 py-2 text-right">毛利率</th>
              <th className="px-3 py-2">備註</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={7}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && data?.sites.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={7}>
                  呢個月暫時冇資料
                </td>
              </tr>
            )}
            {data?.sites.map((s) => (
              <Fragment key={s.site_id}>
                <tr className={`cursor-pointer border-t border-gray-100 hover:bg-gray-50 ${s.below_threshold ? "bg-red-50" : ""}`} onClick={() => toggle(s.site_id)}>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {expanded[s.site_id] ? "▾" : "▸"} {s.site_name} {s.is_monthly_fee && <span className="ml-1 text-xs text-gray-400">（月費盤）</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{s.shifts}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(s.revenue)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(s.cost)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(s.profit)}</td>
                  <td className={`px-3 py-2 text-right ${s.below_threshold ? "font-semibold text-red-600" : ""}`}>{s.margin_pct == null ? "—" : `${s.margin_pct}%`}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{s.note ?? (s.is_monthly_fee ? "更數越多毛利越低" : "")}</td>
                </tr>
                {expanded[s.site_id] &&
                  s.shift_types.map((st, i) => (
                    <tr key={`${s.site_id}-${i}`} className="border-t border-gray-50 bg-gray-50/50 text-xs text-gray-600">
                      <td className="px-3 py-1.5 pl-8">
                        {st.code}
                        {st.label ? `（${st.label}）` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {st.shifts}
                        {st.ot_hours ? ` (${st.ot_hours}h)` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(st.revenue)}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(st.cost)}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(st.profit)}</td>
                      <td></td>
                      <td className="px-3 py-1.5">{st.note}</td>
                    </tr>
                  ))}
                {expanded[s.site_id] && ((s.referral_fee ?? 0) > 0 || (s.longterm_salary_allocated ?? 0) > 0) && (
                  <tr className="border-t border-gray-50 bg-gray-50/50 text-xs text-gray-600">
                    <td className="px-3 py-1.5 pl-8">長工雞頭費 / 長工月薪分攤</td>
                    <td></td>
                    <td></td>
                    <td className="px-3 py-1.5 text-right">{fmtMoney((s.referral_fee ?? 0) + (s.longterm_salary_allocated ?? 0))}</td>
                    <td colSpan={3}></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {data && (
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <td className="px-3 py-2">全公司合計</td>
                <td className="px-3 py-2 text-right">{data.totals.shifts}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(data.totals.revenue)}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(data.totals.cost)}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(data.totals.profit)}</td>
                <td className="px-3 py-2 text-right">{data.totals.margin_pct == null ? "—" : `${data.totals.margin_pct}%`}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
