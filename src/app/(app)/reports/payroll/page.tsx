"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { inputCls, btnSecondary } from "@/components/ui/Field";
import { fmtMoney } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface Total {
  broker_id: string;
  broker_name: string;
  broker_code: string;
  shifts: number;
  wage: number;
  fee: number;
  amount: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function PayrollReportPage() {
  const [month, setMonth] = useState(currentMonth());
  const [totals, setTotals] = useState<Total[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ month: string; totals: Total[] }>(`/api/reports/payroll?month=${month}`);
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setTotals(res.data.totals);
      setLoading(false);
    })();
  }, [month]);

  const grand = totals.reduce((a, t) => ({ shifts: a.shifts + t.shifts, wage: a.wage + t.wage, fee: a.fee + t.fee, amount: a.amount + t.amount }), { shifts: 0, wage: 0, fee: 0, amount: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">糧明細（按雞頭）</h1>
          <p className="text-sm text-gray-500">逐結算單位（雞頭）本月更數／工資／雞頭費／金額。</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" className={inputCls + " max-w-[160px]"} value={month} onChange={(e) => setMonth(e.target.value)} />
          <a href={`/api/reports/payroll?month=${month}&export=1`} className={btnSecondary}>
            匯出 Excel
          </a>
        </div>
      </div>

      <Banner kind="error" message={error} />

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">結算單位（雞頭）</th>
              <th className="px-3 py-2">代號</th>
              <th className="px-3 py-2 text-right">更數</th>
              <th className="px-3 py-2 text-right">工資</th>
              <th className="px-3 py-2 text-right">雞頭費</th>
              <th className="px-3 py-2 text-right">金額</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={6}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading &&
              totals.map((t) => (
                <tr key={t.broker_id} className="border-t border-gray-100">
                  <td className="px-3 py-2">{t.broker_name}</td>
                  <td className="px-3 py-2">{t.broker_code}</td>
                  <td className="px-3 py-2 text-right">{t.shifts}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(t.wage)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(t.fee)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(t.amount)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="px-3 py-2" colSpan={2}>
                Total
              </td>
              <td className="px-3 py-2 text-right">{grand.shifts}</td>
              <td className="px-3 py-2 text-right">{fmtMoney(grand.wage)}</td>
              <td className="px-3 py-2 text-right">{fmtMoney(grand.fee)}</td>
              <td className="px-3 py-2 text-right">{fmtMoney(grand.amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
