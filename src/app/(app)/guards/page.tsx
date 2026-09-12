"use client";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmt, fmtDate, isExpired, isExpiringSoon } from "@/lib/ui/format";

const EMPLOYMENT_TYPES = ["cash_casual", "longterm_autopay", "external", "casual_event"] as const;

interface GuardRow {
  id: string;
  staff_no?: string | null;
  staff_no_mw?: string | null;
  name_zh: string;
  name_en?: string | null;
  tel?: string | null;
  default_broker_id?: string | null;
  employment_type: string;
  monthly_salary?: string | number | null;
  sia_permit_expiry?: string | null;
  polo_size?: string | null;
  status: string;
}
interface BrokerRow {
  id: string;
  code: string;
  name: string;
}

const emptyForm = {
  staff_no: "",
  staff_no_mw: "",
  name_zh: "",
  name_en: "",
  tel: "",
  default_broker_id: "",
  employment_type: EMPLOYMENT_TYPES[0] as string,
  monthly_salary: "",
  sia_permit_expiry: "",
  polo_size: "",
};

export default function GuardsPage() {
  const [rows, setRows] = useState<GuardRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasMoneyField, setHasMoneyField] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const [guardRes, brokerRes] = await Promise.all([
      apiGet<ApiListResult<GuardRow>>("/api/guards?take=500"),
      apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
    ]);
    if (!guardRes.ok) {
      setError(guardRes.message);
      setLoading(false);
      return;
    }
    setRows(guardRes.data.rows);
    setHasMoneyField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "monthly_salary" in r));
    if (brokerRes.ok) setBrokers(brokerRes.data.rows);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function brokerLabel(id?: string | null): string {
    if (!id) return "—";
    const b = brokers.find((x) => x.id === id);
    return b ? `${b.name}（${b.code}）` : id.slice(0, 8);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: GuardRow) {
    setEditingId(row.id);
    setForm({
      staff_no: row.staff_no ?? "",
      staff_no_mw: row.staff_no_mw ?? "",
      name_zh: row.name_zh,
      name_en: row.name_en ?? "",
      tel: row.tel ?? "",
      default_broker_id: row.default_broker_id ?? "",
      employment_type: row.employment_type,
      monthly_salary: row.monthly_salary !== undefined && row.monthly_salary !== null ? String(row.monthly_salary) : "",
      sia_permit_expiry: row.sia_permit_expiry ? row.sia_permit_expiry.slice(0, 10) : "",
      polo_size: row.polo_size ?? "",
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const body: Record<string, unknown> = {
      staff_no: form.staff_no || undefined,
      staff_no_mw: form.staff_no_mw || undefined,
      name_zh: form.name_zh,
      name_en: form.name_en || undefined,
      tel: form.tel || undefined,
      employment_type: form.employment_type,
      sia_permit_expiry: form.sia_permit_expiry || undefined,
      polo_size: form.polo_size || undefined,
    };
    if (!editingId) body.default_broker_id = form.default_broker_id || undefined;
    if (hasMoneyField && form.monthly_salary !== "") body.monthly_salary = Number(form.monthly_salary);

    const res = editingId ? await apiPatch(`/api/guards/${editingId}`, body) : await apiPost("/api/guards", body);
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
    const res = await apiPost(`/api/guards/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已停用");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/guards/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已恢復");
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">保安員名冊</h1>
          <p className="text-sm text-gray-500">許可證 60 日內到期或已過期嘅列會高亮。</p>
        </div>
        <button type="button" onClick={openCreate} className={btnPrimary}>
          新增
        </button>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">工號</th>
              <th className="px-3 py-2">姓名</th>
              <th className="px-3 py-2">電話</th>
              <th className="px-3 py-2">聘用形式</th>
              <th className="px-3 py-2">預設雞頭</th>
              <th className="px-3 py-2">許可證到期</th>
              <th className="px-3 py-2">狀態</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={8}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={8}>
                  暫時冇資料
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const expired = isExpired(r.sia_permit_expiry);
              const expiring = !expired && isExpiringSoon(r.sia_permit_expiry);
              return (
                <tr key={r.id} className={`border-t border-gray-100 ${expired ? "bg-red-50" : expiring ? "bg-amber-50" : ""}`}>
                  <td className="px-3 py-2">{fmt(r.staff_no)}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{r.name_zh}</td>
                  <td className="px-3 py-2">{fmt(r.tel)}</td>
                  <td className="px-3 py-2">{r.employment_type}</td>
                  <td className="px-3 py-2">{brokerLabel(r.default_broker_id)}</td>
                  <td className="px-3 py-2">
                    {fmtDate(r.sia_permit_expiry)}
                    {expired && <span className="ml-1.5 rounded bg-red-200 px-1.5 py-0.5 text-xs text-red-800">已過期</span>}
                    {expiring && <span className="ml-1.5 rounded bg-amber-200 px-1.5 py-0.5 text-xs text-amber-800">快到期</span>}
                  </td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => openEdit(r)} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                        編輯
                      </button>
                      {r.status === "inactive" ? (
                        <button
                          type="button"
                          onClick={() => onUnvoid(r.id)}
                          className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
                        >
                          恢復
                        </button>
                      ) : (
                        <ConfirmVoidButton confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} title={editingId ? "編輯保安員" : "新增保安員"} onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="工號">
              <input className={inputCls} value={form.staff_no} onChange={(e) => setForm((f) => ({ ...f, staff_no: e.target.value }))} />
            </Field>
            <Field label="工號（MW）">
              <input className={inputCls} value={form.staff_no_mw} onChange={(e) => setForm((f) => ({ ...f, staff_no_mw: e.target.value }))} />
            </Field>
          </div>
          <Field label="姓名（中文）">
            <input className={inputCls} value={form.name_zh} onChange={(e) => setForm((f) => ({ ...f, name_zh: e.target.value }))} required />
          </Field>
          <Field label="姓名（英文）">
            <input className={inputCls} value={form.name_en} onChange={(e) => setForm((f) => ({ ...f, name_en: e.target.value }))} />
          </Field>
          <Field label="電話">
            <input className={inputCls} value={form.tel} onChange={(e) => setForm((f) => ({ ...f, tel: e.target.value }))} />
          </Field>
          <Field label="預設雞頭" hint={editingId ? "建立之後唔可以喺呢頁改，要用用戶/雞頭管理" : undefined}>
            <select
              className={selectCls}
              value={form.default_broker_id}
              onChange={(e) => setForm((f) => ({ ...f, default_broker_id: e.target.value }))}
              disabled={!!editingId}
            >
              <option value="">（無）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}（{b.code}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="聘用形式（employment_type）">
            <select
              className={selectCls}
              value={form.employment_type}
              onChange={(e) => setForm((f) => ({ ...f, employment_type: e.target.value }))}
            >
              {EMPLOYMENT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {hasMoneyField ? (
            <Field label="月薪（monthly_salary）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.monthly_salary}
                onChange={(e) => setForm((f) => ({ ...f, monthly_salary: e.target.value }))}
              />
            </Field>
          ) : (
            <Field label="月薪（monthly_salary）">
              <div className="text-sm text-gray-400">—（冇「出街價」權限）</div>
            </Field>
          )}
          <Field label="SIA 許可證到期日">
            <input
              type="date"
              className={inputCls}
              value={form.sia_permit_expiry}
              onChange={(e) => setForm((f) => ({ ...f, sia_permit_expiry: e.target.value }))}
            />
          </Field>
          <Field label="Polo 尺碼">
            <input className={inputCls} value={form.polo_size} onChange={(e) => setForm((f) => ({ ...f, polo_size: e.target.value }))} />
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
