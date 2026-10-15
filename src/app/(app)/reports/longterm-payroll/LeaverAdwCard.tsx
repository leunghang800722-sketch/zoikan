"use client";
// P19b：「離職者平均工資待確認」導航卡——離職者年假補償用咗月薪÷當月日數（或條例自動計但歷史唔齊）時，頁頂彈出；
// 逐人直接輸入平均工資（POST /api/longterm/avg-wages，source 預填「終止僱傭合約薪酬計算表」），儲存後提示重算本月套用。
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/ui/Field";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { fmtMoney } from "@/lib/ui/format";

interface Item {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  leave_date: string;
  basis: string;
  daily_rate_used: number | null;
  suggested_adw: number | null;
  history_incomplete: boolean;
  months_missing: string[];
  balance_days: number;
  saved_awaiting_recompute: boolean;
  saved_avg_daily_wage: number | null;
  advice: string;
}
interface Result {
  month: string;
  items: Item[];
  pending_count: number;
  awaiting_recompute_count: number;
  source_prefill: string;
}

export function LeaverAdwCard({ month, locked, refreshKey, onChanged, onError, onNotice }: { month: string; locked: boolean; refreshKey: string; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [data, setData] = useState<Result | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiGet<Result>(`/api/longterm/leaver-adw?month=${month}`);
    if (res.ok) setData(res.data);
    else setData(null);
  }, [month]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function save(it: Item) {
    const v = Number(values[it.guard_id]);
    if (!Number.isFinite(v) || v <= 0) return onError("平均日薪要係大過 0 嘅數字");
    setBusy(it.guard_id);
    const res = await apiPost(`/api/longterm/avg-wages`, { guard_id: it.guard_id, month: `${month}-01`, avg_daily_wage: v, source: data?.source_prefill ?? "終止僱傭合約薪酬計算表" });
    setBusy(null);
    if (!res.ok) return onError((res as { message: string }).message);
    onNotice(`已儲存平均日薪 ${fmtMoney(v)}——撳右上角「重算本月」套用到年假補償`);
    setValues((p) => ({ ...p, [it.guard_id]: "" }));
    await load();
    onChanged();
  }

  if (!data || data.items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3 sm:p-4" data-testid="leaver-adw-card">
      <div className="text-sm font-semibold text-zk-warning-dark">離職者平均工資待確認（{data.pending_count} 人待輸入{data.awaiting_recompute_count > 0 ? `，${data.awaiting_recompute_count} 人已輸入待重算` : ""}）</div>
      <p className="text-zk-sm text-zk-text">離職補年假要用《僱傭條例》平均工資。系統歷史糧線唔齊，暫用月薪÷當月日數計；請用「{data.source_prefill}」嘅平均日薪輸入，再重算本月。</p>
      <ul className="flex flex-col gap-2">
        {data.items.map((it) => (
          <li key={it.guard_id} className="flex flex-col gap-2 rounded border border-zk-border bg-white p-3" data-testid={`leaver-adw-item-${it.guard_staff_no ?? it.guard_id}`}>
            <div className="text-zk-sm font-semibold">
              {it.guard_name}
              {it.guard_staff_no && <span className="ml-1 font-normal text-zk-faint">（{it.guard_staff_no}）</span>}
              <span className="ml-2 font-normal text-zk-muted">離職日 {it.leave_date}</span>
            </div>
            <div className="text-zk-sm text-zk-text">
              系統用咗日薪 {it.daily_rate_used != null ? fmtMoney(it.daily_rate_used) : "—"}（月薪÷當月日數）× 未放年假 {it.balance_days} 日
              {it.suggested_adw != null && <span>；按條例補入缺失月份參考值 {fmtMoney(it.suggested_adw)}</span>}
              {it.months_missing.length > 0 && <span className="text-zk-faint">（系統缺 {it.months_missing.join("、")} 糧線）</span>}
            </div>
            {it.saved_awaiting_recompute ? (
              <div className="text-zk-sm text-zk-success-dark" data-testid="leaver-adw-saved">已儲存平均日薪 {fmtMoney(it.saved_avg_daily_wage ?? 0)}——{it.advice}</div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  className={`${inputCls} w-36`}
                  placeholder="平均日薪"
                  aria-label={`${it.guard_name} 平均日薪`}
                  value={values[it.guard_id] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [it.guard_id]: e.target.value }))}
                  disabled={locked}
                  data-testid="leaver-adw-input"
                />
                <Button variant="primary" size="sm" onClick={() => void save(it)} disabled={locked || busy === it.guard_id || !values[it.guard_id]} data-testid="leaver-adw-save">
                  儲存平均日薪
                </Button>
                <span className="text-zk-xs text-zk-faint">來源：{data.source_prefill}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
