"use client";
// P15.3：「合約」tab —— 新增合約（月薪制／日薪制）。用 POST /api/longterm/contracts；已鎖月份由 API 擋（403）。
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { apiGet, apiPost } from "@/lib/ui/api-client";

interface GuardHit {
  guard_id: string;
  name: string;
  staff_no: string | null;
}

export function ContractCreateForm({ onCreated, onError, onNotice }: { onCreated: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GuardHit[]>([]);
  const [guard, setGuard] = useState<GuardHit | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [basis, setBasis] = useState<"monthly" | "daily">("monthly");
  const [salary, setSalary] = useState("");
  const [dailyRate, setDailyRate] = useState("");
  const [shiftHours, setShiftHours] = useState("12");
  const [probation, setProbation] = useState("");
  const [leaveDays, setLeaveDays] = useState("7");
  const [shFrom, setShFrom] = useState<"immediate" | "after_3_months">("immediate");
  const [restPaid, setRestPaid] = useState(true);
  const [mpf, setMpf] = useState<"auto" | "none" | "over65" | "under60days">("auto");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function search(v: string) {
    setQ(v);
    setGuard(null);
    if (!v.trim()) return setHits([]);
    const r = await apiGet<{ rows: GuardHit[] }>(`/api/longterm/guard-search?q=${encodeURIComponent(v.trim())}`);
    if (r.ok) setHits(r.data.rows);
  }

  async function submit() {
    if (!guard) return onError("要先搜尋並揀保安員");
    if (!from) return onError("要填生效日");
    const amount = basis === "daily" ? Number(dailyRate) : Number(salary);
    if (!Number.isFinite(amount) || amount <= 0) return onError(basis === "daily" ? "日薪制要填每更價（大過 0）" : "月薪制要填月薪（大過 0）");
    const body: Record<string, unknown> = {
      guard_id: guard.guard_id,
      effective_from: from,
      effective_to: to || null,
      pay_basis: basis,
      // 日薪制：monthly_salary 唔再有月薪意義，但 schema／DB 要有值 → 填同一個每更價
      monthly_salary: amount,
      ...(basis === "daily" ? { daily_rate: amount } : {}),
      shift_hours: Number(shiftHours) || 12,
      annual_leave_days: Number(leaveDays) || 7,
      statutory_holiday_paid_from: shFrom,
      rest_day_paid: restPaid,
      mpf_exempt_reason: mpf,
      ...(probation ? { probation_months: Number(probation) } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setBusy(true);
    const res = await apiPost(`/api/longterm/contracts`, body);
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`已新增${basis === "daily" ? "日薪制" : "月薪制"}合約（${guard.name}，${from} 起）`);
    setOpen(false);
    setQ("");
    setHits([]);
    setGuard(null);
    setFrom("");
    setTo("");
    setSalary("");
    setDailyRate("");
    setNote("");
    onCreated();
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="ltpay-contract-new">
        新增合約
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-contract-form">
      <div className="text-sm font-semibold text-zk-text">新增合約</div>
      <Field label="保安員（搜尋姓名或工號）">
        <input className={inputCls} value={q} onChange={(e) => void search(e.target.value)} placeholder="例：姓名、英文名、工號" data-testid="ltpay-cf-search" />
      </Field>
      {guard ? (
        <div className="text-zk-sm" data-testid="ltpay-cf-picked">
          已揀：{guard.name}
          {guard.staff_no ? `（${guard.staff_no}）` : ""}
        </div>
      ) : (
        hits.length > 0 && (
          <ul className="max-h-40 overflow-auto rounded border border-zk-border-soft text-zk-sm" data-testid="ltpay-cf-hits">
            {hits.map((h) => (
              <li key={h.guard_id}>
                <button type="button" className="w-full px-2 py-1 text-left hover:bg-zk-header" onClick={() => setGuard(h)} data-testid="ltpay-cf-hit">
                  {h.name}
                  {h.staff_no ? `（${h.staff_no}）` : ""}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="生效日">
          <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} data-testid="ltpay-cf-from" />
        </Field>
        <Field label="結束日（可空）">
          <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} data-testid="ltpay-cf-to" />
        </Field>
        <Field label="計薪方式">
          <select className={selectCls} value={basis} onChange={(e) => setBasis(e.target.value as "monthly" | "daily")} data-testid="ltpay-cf-basis">
            <option value="monthly">月薪制</option>
            <option value="daily">日薪制</option>
          </select>
        </Field>
        {basis === "monthly" ? (
          <Field label="月薪">
            <input className={inputCls} inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} data-testid="ltpay-cf-salary" />
          </Field>
        ) : (
          <Field label="每更價">
            <input className={inputCls} inputMode="decimal" value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} data-testid="ltpay-cf-daily" />
          </Field>
        )}
        <Field label="每更時數">
          <input className={inputCls} inputMode="decimal" value={shiftHours} onChange={(e) => setShiftHours(e.target.value)} />
        </Field>
        <Field label="試用期（月）">
          <select className={selectCls} value={probation} onChange={(e) => setProbation(e.target.value)}>
            <option value="">冇</option>
            <option value="1">1</option>
            <option value="3">3</option>
          </select>
        </Field>
        <Field label="年假日數">
          <input className={inputCls} inputMode="decimal" value={leaveDays} onChange={(e) => setLeaveDays(e.target.value)} />
        </Field>
        <Field label="法定假期由">
          <select className={selectCls} value={shFrom} onChange={(e) => setShFrom(e.target.value as "immediate" | "after_3_months")}>
            <option value="immediate">即時（immediate）</option>
            <option value="after_3_months">做滿 3 個月（after_3_months）</option>
          </select>
        </Field>
        <Field label="MPF 免供原因">
          <select className={selectCls} value={mpf} onChange={(e) => setMpf(e.target.value as typeof mpf)}>
            <option value="auto">系統按 Gross 自動判斷</option>
            <option value="none">冇免供</option>
            <option value="over65">65 歲以上</option>
            <option value="under60days">未滿 60 日</option>
          </select>
        </Field>
        <label className="flex items-end gap-1 pb-2 text-zk-sm">
          <input type="checkbox" checked={restPaid} onChange={(e) => setRestPaid(e.target.checked)} /> 例假有薪
        </label>
      </div>
      <Field label="備註">
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={submit} disabled={busy} data-testid="ltpay-cf-submit">
          {busy ? "儲存緊…" : "儲存合約"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
