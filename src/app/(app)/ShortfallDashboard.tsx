"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { fmtMoney } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface SiteRow {
  site_id: string;
  site_name: string;
  required: number;
  confirmed: number;
  shortfall: number;
}
interface Result {
  date: string;
  today: SiteRow[];
  pending_approval_count: number;
  month_progress: {
    month: string;
    revenue?: number;
    cost?: number;
    profit?: number;
    margin_pct: number | null;
    threshold_pct: number;
    below_threshold_site_count: number;
  };
}

export default function ShortfallDashboard() {
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await apiGet<Result>("/api/reports/shortfall");
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setData(res.data);
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="text-sm text-gray-400">載入緊…</div>;
  if (error) return <Banner kind="error" message={error} />;
  if (!data) return null;

  const shortfallSites = data.today.filter((s) => s.shortfall > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">今日尚欠盤數（{data.date}）</div>
          <div className={`mt-1 text-2xl font-semibold ${shortfallSites.length > 0 ? "text-red-600" : "text-gray-900"}`}>{shortfallSites.length}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">待審批數（本月）</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{data.pending_approval_count}</div>
        </div>
        <Link href="/reports/gross-margin" className="rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-400">
          <div className="text-xs text-gray-500">本月毛利進度（{data.month_progress.month}）</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900">{data.month_progress.margin_pct == null ? "—" : `${data.month_progress.margin_pct}%`}</div>
          {data.month_progress.revenue !== undefined && (
            <div className="mt-1 text-xs text-gray-500">
              營業額 {fmtMoney(data.month_progress.revenue)}／毛利 {fmtMoney(data.month_progress.profit)}
            </div>
          )}
          {data.month_progress.below_threshold_site_count > 0 && (
            <div className="mt-1 text-xs text-red-600">
              {data.month_progress.below_threshold_site_count} 個盤毛利率低於 {data.month_progress.threshold_pct}%
            </div>
          )}
        </Link>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-900">今日各盤出勤 vs 所需</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">盤</th>
                <th className="px-3 py-2 text-right">所需</th>
                <th className="px-3 py-2 text-right">已確認</th>
                <th className="px-3 py-2 text-right">尚欠</th>
              </tr>
            </thead>
            <tbody>
              {data.today.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-gray-400" colSpan={4}>
                    今日暫時冇排更資料
                  </td>
                </tr>
              )}
              {data.today.map((s) => (
                <tr key={s.site_id} className={`border-t border-gray-100 ${s.shortfall > 0 ? "bg-red-50" : ""}`}>
                  <td className="px-3 py-2">{s.site_name}</td>
                  <td className="px-3 py-2 text-right">{s.required}</td>
                  <td className="px-3 py-2 text-right">{s.confirmed}</td>
                  <td className={`px-3 py-2 text-right ${s.shortfall > 0 ? "font-semibold text-red-600" : "text-gray-400"}`}>{s.shortfall > 0 ? s.shortfall : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
