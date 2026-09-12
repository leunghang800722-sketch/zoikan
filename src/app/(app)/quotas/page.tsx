"use client";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmtDate } from "@/lib/ui/format";

interface QuotaRow {
  id: string;
  month: string;
  site_id: string;
  shift_type_id: string;
  broker_id: string;
  target_shifts: number;
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

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const emptyForm = { month: currentMonth(), site_id: "", shift_type_id: "", broker_id: "", target_shifts: "" };

export default function QuotasPage() {
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [shiftTypes, setShiftTypes] = useState<ShiftTypeRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [siteFilter, setSiteFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formShiftTypes, setFormShiftTypes] = useState<ShiftTypeRow[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: "500" });
    if (siteFilter) qs.set("site_id", siteFilter);
    if (monthFilter) qs.set("month", monthFilter);
    const res = await apiGet<ApiListResult<QuotaRow>>(`/api/quotas?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteFilter, monthFilter]);

  useEffect(() => {
    (async () => {
      const [siteRes, brokerRes, shiftTypeRes] = await Promise.all([
        apiGet<ApiListResult<SiteRow>>("/api/sites?take=500"),
        apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
        apiGet<ApiListResult<ShiftTypeRow>>("/api/shift-types?take=500"),
      ]);
      if (siteRes.ok) setSites(siteRes.data.rows);
      if (brokerRes.ok) setBrokers(brokerRes.data.rows);
      if (shiftTypeRes.ok) setShiftTypes(shiftTypeRes.data.rows);
    })();
  }, []);

  useEffect(() => {
    if (!form.site_id) {
      setFormShiftTypes([]);
      return;
    }
    apiGet<ApiListResult<ShiftTypeRow>>(`/api/shift-types?site_id=${form.site_id}&take=500`).then((res) => {
      if (res.ok) setFormShiftTypes(res.data.rows);
    });
  }, [form.site_id]);

  function siteLabel(id: string): string {
    return sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8);
  }
  function shiftTypeLabel(id: string): string {
    return shiftTypes.find((s) => s.id === id)?.code ?? id.slice(0, 8);
  }
  function brokerLabel(id: string): string {
    return brokers.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ ...emptyForm, site_id: siteFilter, month: monthFilter || currentMonth() });
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: QuotaRow) {
    setEditingId(row.id);
    setForm({
      month: row.month.slice(0, 7),
      site_id: row.site_id,
      shift_type_id: row.shift_type_id,
      broker_id: row.broker_id,
      target_shifts: String(row.target_shifts),
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const res = editingId
      ? await apiPatch(`/api/quotas/${editingId}`, { target_shifts: Number(form.target_shifts) })
      : await apiPost("/api/quotas", {
          month: form.month,
          site_id: form.site_id,
          shift_type_id: form.shift_type_id,
          broker_id: form.broker_id,
          target_shifts: Number(form.target_shifts),
        });
    setSaving(false);
    if (!res.ok) {
      setFormError(res.message);
      return;
    }
    setDrawerOpen(false);
    setNotice(editingId ? "已更新" : "已新增");
    await load();
  }

  async function onVoid(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/quotas/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已作廢");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/quotas/${id}/unvoid`);
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
          <h1 className="text-lg font-semibold text-gray-900">配額</h1>
          <p className="text-sm text-gray-500">雞頭每月配額——軟性限制，超配額唔會擋更表儲存。</p>
        </div>
        <button type="button" onClick={openCreate} className={btnPrimary}>
          新增
        </button>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="flex flex-wrap gap-2">
        <select className={selectCls + " max-w-xs"} value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">全部盤</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.canonical_name}
            </option>
          ))}
        </select>
        <input type="month" className={inputCls + " max-w-[160px]"} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">月份</th>
              <th className="px-3 py-2">盤</th>
              <th className="px-3 py-2">更別</th>
              <th className="px-3 py-2">雞頭</th>
              <th className="px-3 py-2">目標更數</th>
              <th className="px-3 py-2">操作</th>
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
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={6}>
                  暫時冇資料
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={`border-t border-gray-100 ${r.voided_at ? "opacity-50" : ""}`}>
                <td className="px-3 py-2">{fmtDate(r.month)}</td>
                <td className="px-3 py-2">{siteLabel(r.site_id)}</td>
                <td className="px-3 py-2">{shiftTypeLabel(r.shift_type_id)}</td>
                <td className="px-3 py-2">{brokerLabel(r.broker_id)}</td>
                <td className="px-3 py-2">{r.target_shifts}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => openEdit(r)} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                      編輯
                    </button>
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
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} title={editingId ? "編輯配額" : "新增配額"} onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="月份">
            <input type="month" className={inputCls} value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))} disabled={!!editingId} required />
          </Field>
          <Field label="盤">
            <select
              className={selectCls}
              value={form.site_id}
              onChange={(e) => setForm((f) => ({ ...f, site_id: e.target.value, shift_type_id: "" }))}
              disabled={!!editingId}
              required
            >
              <option value="">請選擇</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="更別">
            <select
              className={selectCls}
              value={form.shift_type_id}
              onChange={(e) => setForm((f) => ({ ...f, shift_type_id: e.target.value }))}
              disabled={!!editingId}
              required
            >
              <option value="">請選擇</option>
              {formShiftTypes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="雞頭">
            <select
              className={selectCls}
              value={form.broker_id}
              onChange={(e) => setForm((f) => ({ ...f, broker_id: e.target.value }))}
              disabled={!!editingId}
              required
            >
              <option value="">請選擇</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目標更數（target_shifts）">
            <input
              type="number"
              min={0}
              className={inputCls}
              value={form.target_shifts}
              onChange={(e) => setForm((f) => ({ ...f, target_shifts: e.target.value }))}
              required
            />
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
