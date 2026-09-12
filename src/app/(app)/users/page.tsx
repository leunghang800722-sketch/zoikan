"use client";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmt } from "@/lib/ui/format";

interface UserRow {
  id: string;
  name: string;
  tel: string;
  role_id: string;
  guard_id?: string | null;
  broker_id?: string | null;
  payout_approval_limit?: string | number | null;
  allowed_ip?: string | null;
  status: string;
}
interface RoleRow {
  id: string;
  name: string;
}
interface BrokerRow {
  id: string;
  code: string;
  name: string;
}

const emptyForm = {
  name: "",
  tel: "",
  password: "",
  role_id: "",
  guard_id: "",
  broker_id: "",
  payout_approval_limit: "",
  allowed_ip: "",
};

export default function UsersPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const [userRes, roleRes, brokerRes] = await Promise.all([
      apiGet<ApiListResult<UserRow>>("/api/users?take=500"),
      apiGet<ApiListResult<RoleRow>>("/api/roles?take=500"),
      apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
    ]);
    if (!userRes.ok) {
      setError(userRes.message);
      setLoading(false);
      return;
    }
    setRows(userRes.data.rows);
    if (roleRes.ok) setRoles(roleRes.data.rows);
    if (brokerRes.ok) setBrokers(brokerRes.data.rows);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function roleLabel(id: string): string {
    return roles.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ ...emptyForm, role_id: roles[0]?.id ?? "" });
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: UserRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      tel: row.tel,
      password: "",
      role_id: row.role_id,
      guard_id: row.guard_id ?? "",
      broker_id: row.broker_id ?? "",
      payout_approval_limit:
        row.payout_approval_limit !== undefined && row.payout_approval_limit !== null ? String(row.payout_approval_limit) : "",
      allowed_ip: row.allowed_ip ?? "",
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);

    if (editingId) {
      const body: Record<string, unknown> = {
        name: form.name,
        role_id: form.role_id,
        guard_id: form.guard_id || undefined,
        broker_id: form.broker_id || undefined,
        payout_approval_limit: form.payout_approval_limit ? Number(form.payout_approval_limit) : undefined,
        allowed_ip: form.allowed_ip || undefined,
      };
      const res = await apiPatch(`/api/users/${editingId}`, body);
      setSaving(false);
      if (!res.ok) {
        setFormError(res.message);
        return;
      }
    } else {
      const body: Record<string, unknown> = {
        name: form.name,
        tel: form.tel,
        password: form.password,
        role_id: form.role_id,
        guard_id: form.guard_id || undefined,
        broker_id: form.broker_id || undefined,
        payout_approval_limit: form.payout_approval_limit ? Number(form.payout_approval_limit) : undefined,
        allowed_ip: form.allowed_ip || undefined,
      };
      const res = await apiPost("/api/users", body);
      setSaving(false);
      if (!res.ok) {
        setFormError(res.message);
        return;
      }
    }
    setDrawerOpen(false);
    setNotice(editingId ? "已更新" : "已新增");
    await load();
  }

  async function onVoid(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/users/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已停用");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/users/${id}/unvoid`);
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
          <h1 className="text-lg font-semibold text-gray-900">用戶管理</h1>
          <p className="text-sm text-gray-500">建立登入帳號、指派角色。</p>
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
              <th className="px-3 py-2">姓名</th>
              <th className="px-3 py-2">電話</th>
              <th className="px-3 py-2">角色</th>
              <th className="px-3 py-2">狀態</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={5}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-gray-400" colSpan={5}>
                  暫時冇資料
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-3 py-2 font-medium text-gray-900">{r.name}</td>
                <td className="px-3 py-2">{fmt(r.tel)}</td>
                <td className="px-3 py-2">{roleLabel(r.role_id)}</td>
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
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} title={editingId ? "編輯用戶" : "新增用戶"} onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="姓名">
            <input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="電話（登入用）">
            <input className={inputCls} value={form.tel} onChange={(e) => setForm((f) => ({ ...f, tel: e.target.value }))} disabled={!!editingId} required />
          </Field>
          {!editingId && (
            <Field label="密碼" hint="管理角色（老闆/主管/會計）要求至少 8 字符，含字母同數字">
              <input
                type="password"
                className={inputCls}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
              />
            </Field>
          )}
          <Field label="角色">
            <select className={selectCls} value={form.role_id} onChange={(e) => setForm((f) => ({ ...f, role_id: e.target.value }))} required>
              <option value="">請選擇</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="掛雞頭（broker_id）" hint="雞頭登入用">
            <select className={selectCls} value={form.broker_id} onChange={(e) => setForm((f) => ({ ...f, broker_id: e.target.value }))}>
              <option value="">（無）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}（{b.code}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="糧務批核上限（payout_approval_limit）" hint="留空＝跟角色預設">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={form.payout_approval_limit}
              onChange={(e) => setForm((f) => ({ ...f, payout_approval_limit: e.target.value }))}
            />
          </Field>
          <Field label="允許登入 IP（allowed_ip）" hint="留空＝不限">
            <input className={inputCls} value={form.allowed_ip} onChange={(e) => setForm((f) => ({ ...f, allowed_ip: e.target.value }))} />
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
