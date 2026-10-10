"use client";
// P2-C：用戶管理版面重新實作（README §16）——欄：名／電話／角色 pill／
// 掛邊個／最後登入／狀態（啟用 綠／待啟用 橙＝從未登入／停用）／操作
// 重設密碼・停用。新增／編輯／停用（void/unvoid）流程本身唔變，淨係
// 換晒 UI 皮；「重設密碼」呢粒掣之前完全冇對應 endpoint，補咗一個
// additive 嘅 `POST /api/users/:id/reset-password`（見嗰個 route 檔
// 頂註解）——用返現有「用戶管理:update」權限，冇加新 permission。
//
// A2（Opus 驗收）：自己嗰行唔顯示「重設密碼」掣（同 API 側 `id ===
// session.userId` → 400 一致，UI 係第一層擋，API 係實際防線）。
// `currentUserId` 由 server component `page.tsx` 讀 session 傳落嚟（同
// `change-password/page.tsx` 一樣做法），呢個 client component 本身
// 唔再自己打 API 攞「我係邊個」。
//
// 頁首「角色」FilterChip（README §16）：users 本身已經全量載入
// （`?take=500`），呢個 filter 淨係喺已經攞到手嘅列表客戶端篩，唔使
// 加 API 參數。
import { useEffect, useMemo, useState } from "react";
import { apiPatch, apiPost, apiGetAll } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { Banner } from "@/components/ui/Banner";
import { Notice } from "@/components/ui/Notice";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmt, fmtDateTime, uiLabel } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

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
  last_login_at?: string | null;
}
interface RoleRow {
  id: string;
  name: string;
  base_role: string;
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

// README「共用元件 · pill」：老闆 紫（monthly variant 同色）；雞頭 青
// （broker variant + 自訂色）；其餘（主管/會計/保安員/自訂角色）灰。用
// `base_role` 而唔係 `name` 判斷，自訂角色（例如「夜班主管」複製自
// 「主管」）都跟返源頭角色嘅色。
function RolePill({ roleName, baseRole }: { roleName: string; baseRole: string }) {
  const label = uiLabel(roleName);
  if (baseRole === "老闆") return <Pill variant="monthly">{label}</Pill>;
  if (baseRole === "雞頭") return <Pill variant="broker" color={{ bg: "#ccfbf1", fg: "#0f766e" }}>{label}</Pill>;
  return <Pill variant="neutral">{label}</Pill>;
}

function statusPill(row: UserRow): React.ReactNode {
  if (row.status === "inactive") return <Pill variant="neutral">停用</Pill>;
  if (!row.last_login_at) return <Pill variant="warning">待啟用</Pill>;
  return <Pill variant="success">啟用</Pill>;
}

export function UsersPageClient({ currentUserId }: { currentUserId: string }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [roleFilter, setRoleFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 「重設密碼」二次確認 ＋ 一次性顯示臨時密碼（見頂註解）。
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{ name: string; password: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const [userRes, roleRes, brokerRes] = await Promise.all([
      apiGetAll<UserRow>("/api/users"),
      apiGetAll<RoleRow>("/api/roles"),
      cachedGetAll<BrokerRow>("/api/brokers"),
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

  function roleOf(id: string): RoleRow | undefined {
    return roles.find((r) => r.id === id);
  }

  // 頁首「角色」FilterChip（README §16）——客戶端篩，users 本身已經全量載入。
  const filteredRows = useMemo(() => (roleFilter ? rows.filter((r) => r.role_id === roleFilter) : rows), [rows, roleFilter]);

  function brokerLabel(id: string | null | undefined): string {
    if (!id) return "—";
    const b = brokers.find((x) => x.id === id);
    return b ? `${b.name}（${b.code}）` : "—";
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

  async function onResetPassword(row: UserRow) {
    setResetting(true);
    setError(null);
    const res = await apiPost<{ temp_password: string }>(`/api/users/${row.id}/reset-password`);
    setResetting(false);
    setConfirmResetId(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResetResult({ name: row.name, password: res.data.temp_password });
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/users")}
        title="用戶管理"
        subtitle="帳號列表；重設密碼會強制對方下次登入改密碼。"
        actions={
          <>
            <FilterChip label="角色">
              <select data-testid="user-role-filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                <option value="">全部</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {uiLabel(r.name)}
                  </option>
                ))}
              </select>
            </FilterChip>
            <Button variant="primary" onClick={openCreate} data-testid="user-create-button">
              新增用戶
            </Button>
          </>
        }
      />

      {error && <Notice variant="error">{error}</Notice>}
      {notice && <Notice variant="info">{notice}</Notice>}
      {resetResult && (
        <div data-testid="user-reset-password-result">
          <Notice
            variant="info"
            action={
              <button type="button" onClick={() => setResetResult(null)} className="text-zk-sm font-semibold text-zk-primary">
                知道了
              </button>
            }
          >
            已重設「{resetResult.name}」嘅密碼，臨時密碼：<strong className="font-mono">{resetResult.password}</strong>
            ——請盡快通知佢，離開此頁後將唔會再顯示，佢下次登入會被要求即時設定新密碼。
          </Notice>
        </div>
      )}

      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(7) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>名</th>
              <th className={tableCls.th}>電話</th>
              <th className={tableCls.th}>角色</th>
              <th className={tableCls.th}>掛邊個</th>
              <th className={tableCls.th}>最後登入</th>
              <th className={tableCls.th}>狀態</th>
              <th className={tableCls.thNum}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3.5 py-4 text-zk-faint" colSpan={7}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && filteredRows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="暫時冇用戶" description="撳右上「新增用戶」開第一個登入帳號。" />
                </td>
              </tr>
            )}
            {filteredRows.map((r) => {
              const role = roleOf(r.role_id);
              return (
                <tr key={r.id} data-testid="user-row" className={tableCls.rowHover}>
                  <td className={`${tableCls.td} font-medium`}>{r.name}</td>
                  <td className={tableCls.td}>{fmt(r.tel)}</td>
                  <td className={tableCls.td}>
                    {role ? <RolePill roleName={role.name} baseRole={role.base_role} /> : <span className="text-zk-faint">—</span>}
                  </td>
                  <td className={tableCls.td}>{brokerLabel(r.broker_id)}</td>
                  <td className={`${tableCls.td} text-zk-muted`}>{r.last_login_at ? fmtDateTime(r.last_login_at) : "從未登入"}</td>
                  <td className={tableCls.td} data-testid="user-status-pill">
                    {statusPill(r)}
                  </td>
                  <td className={tableCls.tdNum}>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-[9px] py-[3px] text-xs text-zk-text-secondary hover:bg-zk-header">
                        編輯
                      </button>
                      {/* A2：自己嗰行唔顯示「重設密碼」——同 API 側 id === session.userId
                          擋一致，應該用改密碼頁改自己嘅密碼。 */}
                      {r.id !== currentUserId &&
                        (confirmResetId === r.id ? (
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              data-testid="user-reset-password-confirm"
                              disabled={resetting}
                              onClick={() => onResetPassword(r)}
                              className="rounded-[5px] bg-zk-primary px-[9px] py-[3px] text-xs font-semibold text-white disabled:opacity-50"
                            >
                              {resetting ? "重設緊…" : "確定重設"}
                            </button>
                            <button type="button" onClick={() => setConfirmResetId(null)} className="rounded-[5px] px-[9px] py-[3px] text-xs text-zk-muted hover:bg-zk-header">
                              取消
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            data-testid="user-reset-password-button"
                            onClick={() => setConfirmResetId(r.id)}
                            className="rounded-[5px] border border-zk-border px-[9px] py-[3px] text-xs text-zk-text-secondary hover:bg-zk-header"
                          >
                            重設密碼
                          </button>
                        ))}
                      {r.status === "inactive" ? (
                        <button
                          type="button"
                          onClick={() => onUnvoid(r.id)}
                          className="rounded-[5px] border border-[#a7f3d0] px-[9px] py-[3px] text-xs text-zk-success-dark hover:bg-zk-success-bg"
                        >
                          恢復
                        </button>
                      ) : (
                        <ConfirmVoidButton label="停用" confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
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
                  {uiLabel(r.name)}
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
