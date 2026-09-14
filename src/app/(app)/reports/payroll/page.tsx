"use client";
// P2-B：糧明細（按雞頭）（README §14）——逐結算單位（雞頭）本月更數／
// 工資／雞頭費／金額；foot 合計。Generate／匯出 API 唔變。
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, currentMonthStr } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface Total {
  broker_id: string;
  broker_name: string;
  broker_code: string;
  broker_kind?: string;
  shifts: number;
  wage: number;
  fee: number;
  amount: number;
}

const COLS = 7; // 結算單位/代號/種類/更數/工資/雞頭費/金額

function kindLabel(kind?: string): string {
  switch (kind) {
    case "internal_cash":
      return "公司兵";
    case "internal_longterm":
      return "公司長工";
    case "external":
      return "外部";
    case "special":
      return "特殊";
    default:
      return "外判";
  }
}

export default function PayrollReportPage() {
  const [month, setMonth] = useState(() => currentMonthStr());
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
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="財務"
        title="糧明細（按雞頭）"
        subtitle="逐結算單位（雞頭）本月更數／工資／雞頭費／金額。"
        actions={
          <>
            <FilterChip label="月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <a href={`/api/reports/payroll?month=${month}&export=1`}>
              <Button variant="secondary">匯出 Excel</Button>
            </a>
          </>
        }
      />

      <Banner kind="error" message={error} />

      {/* 桌面表。 */}
      <div className={`hidden md:block ${tableCls.wrap}`}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(COLS) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>結算單位</th>
              <th className={tableCls.th}>代號</th>
              <th className={tableCls.th}>種類</th>
              <th className={tableCls.thNum}>更數</th>
              <th className={tableCls.thNum}>工資</th>
              <th className={tableCls.thNum}>雞頭費</th>
              <th className={tableCls.thNum}>金額</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3.5 py-4 text-sm text-zk-faint" colSpan={7}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && totals.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="呢個月暫時冇資料" />
                </td>
              </tr>
            )}
            {!loading &&
              totals.map((t) => (
                <tr key={t.broker_id} className={tableCls.rowHover}>
                  <td className={`${tableCls.td} font-medium`}>{t.broker_name}</td>
                  <td className={tableCls.td}>{t.broker_code}</td>
                  <td className={tableCls.td}>
                    <Pill variant="neutral">{kindLabel(t.broker_kind)}</Pill>
                  </td>
                  <td className={tableCls.tdNum}>{t.shifts}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(t.wage)}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(t.fee)}</td>
                  <td className={`${tableCls.tdNum} font-semibold`}>{fmtMoney(t.amount)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${tableCls.td} ${tableCls.foot}`} colSpan={3}>
                Total
              </td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{grand.shifts}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.wage)}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.fee)}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 手機：每行變卡。 */}
      <div className="flex flex-col gap-2 md:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : totals.length === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {totals.map((t) => (
              <div key={t.broker_id} className="flex items-center justify-between gap-2.5 border-b border-[#f1f5f9] px-3.5 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-zk-text">{t.broker_name}</span>
                    <Pill variant="neutral">{t.broker_code}</Pill>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-zk-muted">
                    {kindLabel(t.broker_kind)} · {t.shifts} 更
                  </div>
                </div>
                <div className="shrink-0 text-[13px] font-semibold text-zk-text">{fmtMoney(t.amount)}</div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-zk-border bg-zk-header px-3.5 py-2.5 text-[13px] font-bold text-zk-text">
              <span>Total {grand.shifts} 更</span>
              <span>{fmtMoney(grand.amount)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
