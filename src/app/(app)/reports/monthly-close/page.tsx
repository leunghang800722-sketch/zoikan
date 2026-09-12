"use client";
import { useState } from "react";
import { apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Field, inputCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmtMoney } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface MonthCloseDto {
  id: string;
  month: string;
  locked_at: string | null;
}
interface SiteRow {
  site_id: string;
  canonical_name: string;
  shifts: number;
  revenue?: number;
  cost: number;
  profit?: number;
  margin_pct?: number | null;
  note: string | null;
}
interface ReconciliationRule {
  rule: number;
  rule_no: number;
  key: string;
  label: string;
  title: string;
  status: "pass" | "diff" | "not_enabled";
  diff_count: number;
  details: Array<Record<string, unknown>>;
  note: string | null;
}
interface GenerateResult {
  month_close: MonthCloseDto;
  monthly_close: { main_rows: SiteRow[]; outside_rows: SiteRow[] };
  reconciliation: { month: string; rules: ReconciliationRule[]; has_diff: boolean };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function MonthlyCloseWorkbenchPage() {
  const [month, setMonth] = useState(currentMonth());
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [unlockReason, setUnlockReason] = useState("");

  async function generate() {
    setLoading(true);
    setError(null);
    // month 段接受 "YYYY-MM"——見 src/lib/month-lock.ts resolveMonthCloseIdOrMonth()
    const res = await apiPost<GenerateResult>(`/api/month-closes/${month}/generate`);
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
  }

  async function lock() {
    if (!result) return;
    setError(null);
    const res = await apiPost(`/api/month-closes/${result.month_close.id}/lock`, result.reconciliation.has_diff ? { override_reason: overrideReason } : {});
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已鎖定");
    setOverrideReason("");
    await generate();
  }

  async function unlock() {
    if (!result) return;
    setError(null);
    const res = await apiPost(`/api/month-closes/${result.month_close.id}/unlock`, { reason: unlockReason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已解鎖");
    setUnlockReason("");
    await generate();
  }

  const locked = !!result?.month_close.locked_at;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">月結工作台</h1>
          <p className="text-sm text-gray-500">生成月結總表＋五條自動對數規則（§6.3）；鎖定前必須先 Generate 一次。</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" className={inputCls + " max-w-[160px]"} value={month} onChange={(e) => setMonth(e.target.value)} />
          <button type="button" className={btnPrimary} onClick={generate} disabled={loading}>
            {loading ? "生成緊…" : "Generate"}
          </button>
          <a href={`/api/reports/monthly-close?month=${month}&export=1`} className={btnSecondary}>
            匯出 Excel
          </a>
        </div>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {result && (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                {result.month_close.month.slice(0, 7)}——狀態：
                <span className={locked ? "font-semibold text-red-600" : "font-semibold text-green-600"}>{locked ? "已鎖定" : "未鎖定"}</span>
                {locked && <span className="ml-2 text-xs text-gray-400">{result.month_close.locked_at}</span>}
              </div>
              {!locked ? (
                <div className="flex items-center gap-2">
                  {result.reconciliation.has_diff && (
                    <input
                      className={inputCls + " max-w-xs"}
                      placeholder="有紅色差異，鎖定要填 override 原因"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  )}
                  <button type="button" className={btnPrimary} onClick={lock} disabled={result.reconciliation.has_diff && !overrideReason.trim()}>
                    鎖定
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input className={inputCls + " max-w-xs"} placeholder="解鎖原因" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
                  <button type="button" className={btnSecondary} onClick={unlock} disabled={!unlockReason.trim()}>
                    解鎖
                  </button>
                </div>
              )}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-gray-900">§6.3 五條自動對數規則</h2>
            {/* Opus 驗收 A5：邊條紅一眼睇晒（用 key/label，唔使逐條展開）。 */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {result.reconciliation.rules.map((r) => (
                <span
                  key={`chip-${r.key}`}
                  data-rule-key={r.key}
                  data-rule-status={r.status}
                  className={`rounded px-2 py-0.5 text-xs ${r.status === "diff" ? "bg-red-600 text-white" : r.status === "not_enabled" ? "bg-gray-200 text-gray-500" : "bg-green-600 text-white"}`}
                >
                  {r.rule}. {r.label}
                </span>
              ))}
            </div>
            <div className="space-y-2">
              {result.reconciliation.rules.map((r) => (
                <div
                  key={r.rule_no}
                  data-rule-key={r.key}
                  className={`rounded-lg border p-3 text-sm ${r.status === "diff" ? "border-red-300 bg-red-50" : r.status === "not_enabled" ? "border-gray-200 bg-gray-50" : "border-green-200 bg-green-50"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium">
                      {r.rule}. {r.label}（{r.title}）
                    </div>
                    <div className="text-xs">
                      {r.status === "pass" && <span className="text-green-700">通過</span>}
                      {r.status === "diff" && <span className="font-semibold text-red-700">{r.diff_count} 項差異</span>}
                      {r.status === "not_enabled" && <span className="text-gray-500">未啟用</span>}
                    </div>
                  </div>
                  {r.note && <div className="mt-1 text-xs text-gray-500">{r.note}</div>}
                  {r.details.length > 0 && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded bg-white p-2 text-[11px] text-gray-600">{JSON.stringify(r.details.slice(0, 20), null, 1)}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-gray-900">月結總表（月結對照 R2 口徑）</h2>
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2">工作地點</th>
                    <th className="px-3 py-2 text-right">更數</th>
                    <th className="px-3 py-2 text-right">營業額</th>
                    <th className="px-3 py-2 text-right">成本</th>
                    <th className="px-3 py-2 text-right">盈利</th>
                    <th className="px-3 py-2 text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {result.monthly_close.main_rows.map((r) => (
                    <tr key={r.site_id} className="border-t border-gray-100">
                      <td className="px-3 py-1.5">{r.canonical_name}</td>
                      <td className="px-3 py-1.5 text-right">{r.shifts}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(r.revenue)}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(r.cost)}</td>
                      <td className="px-3 py-1.5 text-right">{fmtMoney(r.profit)}</td>
                      <td className="px-3 py-1.5 text-right">{r.margin_pct == null ? "n/a" : `${r.margin_pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!result && <Field label="">{<span className="text-sm text-gray-400">撳 Generate 開始。</span>}</Field>}
    </div>
  );
}
