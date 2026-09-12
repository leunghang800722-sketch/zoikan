"use client";
import { useEffect, useState } from "react";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmtDate, fmtMoney } from "@/lib/ui/format";

const BILLING_MODELS = ["per_shift", "monthly_fixed", "admin_fee", "special"] as const;
const PAGE_SIZE = 50;

interface RateCardRow {
  id: string;
  site_id: string;
  shift_type_id?: string | null;
  broker_id?: string | null;
  guard_id?: string | null;
  client_rate?: string | number | null;
  guard_wage?: string | number | null;
  broker_fee?: string | number | null;
  payout_rate?: string | number | null;
  billing_model?: string | null;
  effective_from: string;
  effective_to?: string | null;
  note?: string | null;
  voided_at?: string | null;
}
interface SiteRow {
  id: string;
  canonical_name: string;
}
interface ShiftTypeRow {
  id: string;
  site_id: string;
  code: string;
}
interface BrokerRow {
  id: string;
  code: string;
  name: string;
}
interface GuardRow {
  id: string;
  staff_no?: string | null;
  name_zh: string;
}

const emptyForm = {
  site_id: "",
  shift_type_id: "",
  broker_id: "",
  guard_id: "",
  client_rate: "",
  guard_wage: "",
  broker_fee: "",
  payout_rate: "",
  billing_model: "",
  effective_from: "",
  effective_to: "",
  note: "",
};

export default function RateCardsPage() {
  const [rows, setRows] = useState<RateCardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [siteFilter, setSiteFilter] = useState("");
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [shiftTypes, setShiftTypes] = useState<ShiftTypeRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [guards, setGuards] = useState<GuardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasClientRate, setHasClientRate] = useState(true);
  const [hasPayoutRate, setHasPayoutRate] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) });
    if (siteFilter) qs.set("site_id", siteFilter);
    const res = await apiGet<ApiListResult<RateCardRow>>(`/api/rate-cards?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setTotal(res.data.total);
    setHasClientRate(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "client_rate" in r));
    setHasPayoutRate(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "payout_rate" in r));
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteFilter, skip]);

  useEffect(() => {
    (async () => {
      const [siteRes, brokerRes, guardRes] = await Promise.all([
        apiGet<ApiListResult<SiteRow>>("/api/sites?take=500"),
        apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
        apiGet<ApiListResult<GuardRow>>("/api/guards?take=500"),
      ]);
      if (siteRes.ok) setSites(siteRes.data.rows);
      if (brokerRes.ok) setBrokers(brokerRes.data.rows);
      if (guardRes.ok) setGuards(guardRes.data.rows);
    })();
  }, []);

  useEffect(() => {
    if (!form.site_id) {
      setShiftTypes([]);
      return;
    }
    apiGet<ApiListResult<ShiftTypeRow>>(`/api/shift-types?site_id=${form.site_id}&take=500`).then((res) => {
      if (res.ok) setShiftTypes(res.data.rows);
    });
  }, [form.site_id]);

  function siteLabel(id: string): string {
    return sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8);
  }
  function shiftTypeLabel(id?: string | null): string {
    if (!id) return "通用";
    return shiftTypes.find((s) => s.id === id)?.code ?? id.slice(0, 8);
  }
  function brokerLabel(id?: string | null): string {
    if (!id) return "通用";
    const b = brokers.find((x) => x.id === id);
    return b ? b.name : id.slice(0, 8);
  }
  function guardLabel(id?: string | null): string {
    if (!id) return "通用";
    const g = guards.find((x) => x.id === id);
    return g ? g.name_zh : id.slice(0, 8);
  }

  function openCreate() {
    setForm({ ...emptyForm, site_id: siteFilter || "" });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const body: Record<string, unknown> = {
      site_id: form.site_id,
      shift_type_id: form.shift_type_id || undefined,
      broker_id: form.broker_id || undefined,
      guard_id: form.guard_id || undefined,
      guard_wage: form.guard_wage ? Number(form.guard_wage) : undefined,
      broker_fee: form.broker_fee ? Number(form.broker_fee) : undefined,
      billing_model: form.billing_model || undefined,
      effective_from: form.effective_from,
      effective_to: form.effective_to || undefined,
      note: form.note || undefined,
    };
    if (hasClientRate && form.client_rate !== "") body.client_rate = Number(form.client_rate);
    if (hasPayoutRate && form.payout_rate !== "") body.payout_rate = Number(form.payout_rate);

    const res = await apiPost("/api/rate-cards", body);
    setSaving(false);
    if (!res.ok) {
      setFormError(res.message);
      return;
    }
    setDrawerOpen(false);
    setNotice("已新增");
    await load();
  }

  async function onVoid(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/rate-cards/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已作廢");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/rate-cards/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已解除作廢");
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">價目</h1>
          <p className="text-sm text-gray-500">收客價／出街價——冇對應權限嘅欄一律顯示「—」。</p>
        </div>
        <button type="button" onClick={openCreate} className={btnPrimary}>
          新增
        </button>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <select
        className={selectCls + " max-w-xs"}
        value={siteFilter}
        onChange={(e) => {
          setSiteFilter(e.target.value);
          setSkip(0);
        }}
      >
        <option value="">全部盤</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.canonical_name}
          </option>
        ))}
      </select>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">盤</th>
              <th className="px-3 py-2">更別</th>
              <th className="px-3 py-2">雞頭</th>
              <th className="px-3 py-2">安員</th>
              <th className="px-3 py-2">收客價</th>
              <th className="px-3 py-2">出街價</th>
              <th className="px-3 py-2">安員工資</th>
              <th className="px-3 py-2">雞頭費</th>
              <th className="px-3 py-2">生效期</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={10}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={10}>
                  暫時冇資料
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={`border-t border-gray-100 ${r.voided_at ? "opacity-50" : ""}`}>
                <td className="px-3 py-2">{siteLabel(r.site_id)}</td>
                <td className="px-3 py-2">{shiftTypeLabel(r.shift_type_id)}</td>
                <td className="px-3 py-2">{brokerLabel(r.broker_id)}</td>
                <td className="px-3 py-2">{guardLabel(r.guard_id)}</td>
                <td className="px-3 py-2">{hasClientRate ? fmtMoney(r.client_rate) : "—"}</td>
                <td className="px-3 py-2">{hasPayoutRate ? fmtMoney(r.payout_rate) : "—"}</td>
                <td className="px-3 py-2">{fmtMoney(r.guard_wage)}</td>
                <td className="px-3 py-2">{fmtMoney(r.broker_fee)}</td>
                <td className="px-3 py-2">
                  {fmtDate(r.effective_from)} – {r.effective_to ? fmtDate(r.effective_to) : "無限期"}
                </td>
                <td className="px-3 py-2">
                  {r.voided_at ? (
                    <button
                      type="button"
                      onClick={() => onUnvoid(r.id)}
                      className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
                    >
                      解除作廢
                    </button>
                  ) : (
                    <ConfirmVoidButton onConfirm={(reason) => onVoid(r.id, reason)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>
          共 {total} 條，第 {Math.floor(skip / PAGE_SIZE) + 1} 頁
        </span>
        <div className="flex gap-2">
          <button type="button" disabled={skip === 0} onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))} className={btnSecondary}>
            上一頁
          </button>
          <button type="button" disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip((s) => s + PAGE_SIZE)} className={btnSecondary}>
            下一頁
          </button>
        </div>
      </div>

      <Drawer open={drawerOpen} title="新增價目" onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="盤">
            <select className={selectCls} value={form.site_id} onChange={(e) => setForm((f) => ({ ...f, site_id: e.target.value, shift_type_id: "" }))} required>
              <option value="">請選擇</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="更別" hint="留空＝通用">
            <select className={selectCls} value={form.shift_type_id} onChange={(e) => setForm((f) => ({ ...f, shift_type_id: e.target.value }))}>
              <option value="">（通用）</option>
              {shiftTypes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="雞頭" hint="留空＝通用">
            <select className={selectCls} value={form.broker_id} onChange={(e) => setForm((f) => ({ ...f, broker_id: e.target.value }))}>
              <option value="">（通用）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="安員" hint="留空＝通用">
            <select className={selectCls} value={form.guard_id} onChange={(e) => setForm((f) => ({ ...f, guard_id: e.target.value }))}>
              <option value="">（通用）</option>
              {guards.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name_zh}
                  {g.staff_no ? `（${g.staff_no}）` : ""}
                </option>
              ))}
            </select>
          </Field>
          {hasClientRate && (
            <Field label="收客價（client_rate）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.client_rate}
                onChange={(e) => setForm((f) => ({ ...f, client_rate: e.target.value }))}
              />
            </Field>
          )}
          <Field label="安員工資（guard_wage）">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={form.guard_wage}
              onChange={(e) => setForm((f) => ({ ...f, guard_wage: e.target.value }))}
            />
          </Field>
          <Field label="雞頭費（broker_fee）">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={form.broker_fee}
              onChange={(e) => setForm((f) => ({ ...f, broker_fee: e.target.value }))}
            />
          </Field>
          {hasPayoutRate && (
            <Field label="出街價（payout_rate）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.payout_rate}
                onChange={(e) => setForm((f) => ({ ...f, payout_rate: e.target.value }))}
              />
            </Field>
          )}
          <Field label="結算模式（billing_model）">
            <select className={selectCls} value={form.billing_model} onChange={(e) => setForm((f) => ({ ...f, billing_model: e.target.value }))}>
              <option value="">（沿用盤設定）</option>
              {BILLING_MODELS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="生效日期">
              <input
                type="date"
                className={inputCls}
                value={form.effective_from}
                onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))}
                required
              />
            </Field>
            <Field label="失效日期" hint="留空＝無限期">
              <input
                type="date"
                className={inputCls}
                value={form.effective_to}
                onChange={(e) => setForm((f) => ({ ...f, effective_to: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="備註">
            <input className={inputCls} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </Field>
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={saving} className={btnPrimary}>
              {saving ? "儲存緊…" : "儲存"}
            </button>
            <button type="button" onClick={() => setDrawerOpen(false)} className={btnSecondary}>
              取消
            </button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
