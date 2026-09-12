"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { inputCls } from "@/components/ui/Field";
import { fmtMoney, fmtDate } from "@/lib/ui/format";

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
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function MyReceivablePage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      const res = await apiGet<Result>(`/api/reports/my-receivable?month=${month}`);
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setData(res.data);
      setLoading(false);
    })();
  }, [month]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">本月應收</h1>
          <p className="text-sm text-gray-500">自己安員本月更數 × 自己出街價，逐日明細。</p>
        </div>
        <input type="month" className={inputCls + " max-w-[160px]"} value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>

      <Banner kind="error" message={error} />

      {data && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-sm text-gray-500">
            {data.total_shifts} 更 · 合計 <span className="text-lg font-semibold text-gray-900">{fmtMoney(data.total)}</span>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">日期</th>
              <th className="px-3 py-2">盤</th>
              <th className="px-3 py-2">更別</th>
              <th className="px-3 py-2 text-right">金額</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={4}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && (data?.days.length ?? 0) === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={4}>
                  呢個月暫時冇資料
                </td>
              </tr>
            )}
            {data?.days.map((d, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-3 py-2">{fmtDate(d.work_date)}</td>
                <td className="px-3 py-2">{d.site_name}</td>
                <td className="px-3 py-2">{d.shift_type_code}</td>
                <td className="px-3 py-2 text-right">{fmtMoney(d.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
