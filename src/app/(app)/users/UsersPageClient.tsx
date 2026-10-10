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
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { tableCls, EmptyState, TableLoadingRow } from "@/components/ui/DataTable";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { fmt, fmtDateTime, uiLabel } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";
import { useCrudPage } from "@/lib/ui/use-crud-page";

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
  if (baseRole === "雞頭") return <Pill variant="broker" color={{ bg: "var(--zk-success-tint)", fg: "var(--zk-success)" }}>{label}</Pill>;
  return <Pill variant="neutral">{label}</Pill>;
}

function statusPill(row: UserRow): React.ReactNode {
  if (row.status === "inactive") return <Pill variant="neutral">停用</Pill>;
  if (!row.last_login_at) return <Pill variant="warning">待啟用</Pill>;
  return <Pill variant="success">啟用</Pill>;
}

export function UsersPageClient({ currentUserId }: { currentUserId: string }) {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [roleFilter, setRoleFilter] = useState("");
  const {
    rows, setRows, loading, setLoading, error, setError, notice, drawerOpen, setDrawerOpen, editingId, form, setForm, formError, saving,
    openCreate: openCreateDrawer, openEdit: openEditDrawer, saveForm, runAction,
  } = useCrudPage<UserRow, typeof emptyForm>(emptyForm);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    openCreateDrawer({ ...emptyForm, role_id: roles[0]?.id ?? "" });
  }

  function openEdit(row: UserRow) {
    openEditDrawer(row.id, {
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
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await saveForm(() => {
      if (editingId) {
        const body: Record<string, unknown> = {
          name: form.name,
          role_id: form.role_id,
          guard_id: form.guard_id || undefined,
          broker_id: form.broker_id || undefined,
          payout_approval_limit: form.payout_approval_limit ? Number(form.payout_approval_limit) : undefined,
          allowed_ip: form.allowed_ip || undefined,
        };
        return apiPatch(`/api/users/${editingId}`, body);
      }
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
      return apiPost("/api/users", body);
    }, load);
  }

  async function onVoid(id: string, reason: string) {
    await runAction(() => apiPost(`/api/users/${id}/void`, { reason }), "已停用", load);
  }

  async function onUnvoid(id: string) {
    await runAction(() => apiPost(`/api/users/${id}/unvoid`), "已恢復", load);
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

      {error && <Banner compact kind="error">{error}</Banner>}
      {notice && <Banner compact kind="info">{notice}</Banner>}
      {resetResult && (
        <div data-testid="user-reset-password-result">
          <Banner compact
            kind="info"
            action={
              <Button variant="link" size="sm" type="button" onClick={() => setResetResult(null)}>
                知道了
              </Button>
            }
          >
            已重設「{resetResult.name}」嘅密碼，臨時密碼：<strong className="font-mono">{resetResult.password}</strong>
            ——請盡快通知佢，離開此頁後將唔會再顯示，佢下次登入會被要求即時設定新密碼。
          </Banner>
        </div>
      )}

      <div className={tableCls.wrap}>
        <table className="w-full border-collapse text-zk-base max-sm:block sm:min-w-[826px]">
          <thead className="max-sm:hidden">
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
          <tbody className="max-sm:block">
            {loading && (
              <TableLoadingRow colSpan={7} />
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
                <tr key={r.id} data-testid="user-row" className={`${tableCls.rowHover} max-sm:flex max-sm:flex-col max-sm:gap-0.5 max-sm:border-b max-sm:border-zk-border-soft max-sm:px-3.5 max-sm:py-3`}>
                  <td className={`${tableCls.td} font-medium max-sm:border-0 max-sm:px-0 max-sm:py-0.5`}>{r.name}</td>
                  <td className={`${tableCls.td} max-sm:border-0 max-sm:px-0 max-sm:py-0.5`}>{fmt(r.tel)}</td>
                  <td className={`${tableCls.td} max-sm:border-0 max-sm:px-0 max-sm:py-0.5`}>
                    {role ? <RolePill roleName={role.name} baseRole={role.base_role} /> : <span className="text-zk-faint">—</span>}
                  </td>
                  <td className={`${tableCls.td} max-sm:border-0 max-sm:px-0 max-sm:py-0.5`}>{brokerLabel(r.broker_id)}</td>
                  <td className={`${tableCls.td} text-zk-muted max-sm:border-0 max-sm:px-0 max-sm:py-0.5`}>{r.last_login_at ? fmtDateTime(r.last_login_at) : "從未登入"}</td>
                  <td className={`${tableCls.td} max-sm:border-0 max-sm:px-0 max-sm:py-0.5`} data-testid="user-status-pill">
                    {statusPill(r)}
                  </td>
                  <td className={`${tableCls.tdNum} max-sm:border-0 max-sm:px-0 max-sm:py-1 max-sm:text-left`}>
                    <div className="flex flex-wrap items-center justify-end gap-1.5 max-sm:justify-start">
                      <Button variant="secondary" size="sm" type="button" onClick={() => openEdit(r)}>
                        編輯
                      </Button>
                      {/* A2：自己嗰行唔顯示「重設密碼」——同 API 側 id === session.userId
                          擋一致，應該用改密碼頁改自己嘅密碼。 */}
                      {r.id !== currentUserId &&
                        (confirmResetId === r.id ? (
                          <span className="flex items-center gap-1">
                            <Button variant="primary" size="sm"
                              type="button"
                              data-testid="user-reset-password-confirm"
                              disabled={resetting}
                              onClick={() => onResetPassword(r)}

                            >
                              {resetting ? "重設緊…" : "確定重設"}
                            </Button>
                            <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmResetId(null)}>
                              取消
                            </Button>
                          </span>
                        ) : (
                          <Button variant="secondary" size="sm"
                            type="button"
                            data-testid="user-reset-password-button"
                            onClick={() => setConfirmResetId(r.id)}

                          >
                            重設密碼
                          </Button>
                        ))}
                      {r.status === "inactive" ? (
                        <Button variant="secondary" size="sm"
                          type="button"
                          onClick={() => onUnvoid(r.id)}

                        >
                          恢復
                        </Button>
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
            <Button variant="primary" size="sm" type="submit" disabled={saving}>
              {saving ? "儲存緊…" : "儲存"}
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => setDrawerOpen(false)}>
              取消
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
