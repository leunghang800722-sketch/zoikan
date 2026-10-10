"use client";
// P2-C：角色權限管理版面重新實作（README §17）——左邊角色列表卡（右側
// 「N 人」，選中底 `#eff6ff`）＋「複製角色」卡；右邊矩陣卡（頭「角色名
// ＋系統預設角色/自訂角色 · N 個帳號」，欄 模組／睇／增／改／刪／出，
// checkbox 18px 圓角 5px 樣式，硬性禁止格底 `#f8fafc`）。權限邏輯／
// API（GET/PATCH /api/roles/:id/permissions、POST /api/roles 複製）完全
// 不變，淨係換皮。
import { uiLabel } from "@/lib/ui/format";
import { moduleLabel } from "@/lib/rbac/labels";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { inputCls, selectCls } from "@/components/ui/Field";
import { ACTIONS, MODULES, type Action, type Module } from "@/lib/rbac/matrix";

interface RoleRow {
  id: string;
  name: string;
  base_role: string;
  is_custom: boolean;
  payout_approval_limit?: string | number | null;
  voided_at?: string | null;
}
interface UserRow {
  id: string;
  role_id: string;
}
interface PermissionCell {
  module: Module;
  action: Action;
  granted: boolean;
  hard_denied: boolean;
}
interface PermissionsResponse {
  role_id: string;
  role_name: string;
  base_role: string;
  cells: PermissionCell[];
}

const ACTION_LABEL: Record<Action, string> = { view: "睇", create: "增", update: "改", void: "刪", export: "出" };

// README「角色權限管理」矩陣 checkbox：勾選底/邊 `#2563eb` 白「✓」；
// 未勾白底灰邊；硬性禁止底 `#f1f5f9` 邊 `#e5e7eb`（唔可以撳，唔理
// granted 值），整格底 `#f8fafc`。
function MatrixCheckbox({ granted, hardDenied, onToggle }: { granted: boolean; hardDenied: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={granted}
      aria-disabled={hardDenied}
      disabled={hardDenied}
      onClick={onToggle}
      data-testid="role-matrix-checkbox"
      data-hard-denied={hardDenied ? "1" : "0"}
      title={hardDenied ? "硬性禁止" : undefined}
      className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border text-[12px] font-bold ${
        hardDenied
          ? "cursor-not-allowed border-zk-border bg-zk-surface text-transparent"
          : granted
            ? "cursor-pointer border-zk-primary bg-zk-primary text-white"
            : "cursor-pointer border-zk-input-border bg-white text-transparent"
      }`}
    >
      ✓
    </button>
  );
}

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<PermissionsResponse | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [dirty, setDirty] = useState<Map<string, boolean>>(new Map());
  const [savingMatrix, setSavingMatrix] = useState(false);

  const [copySourceId, setCopySourceId] = useState("");
  const [copyName, setCopyName] = useState("");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  async function loadRoles() {
    setLoading(true);
    setError(null);
    const [roleRes, userRes] = await Promise.all([
      apiGet<ApiListResult<RoleRow>>("/api/roles?take=500"),
      apiGet<ApiListResult<UserRow>>("/api/users?take=500&include_inactive=1"),
    ]);
    if (!roleRes.ok) {
      setError(roleRes.message);
      setLoading(false);
      return;
    }
    setRoles(roleRes.data.rows);
    if (userRes.ok) setUsers(userRes.data.rows);
    if (!selectedId && roleRes.data.rows.length > 0) setSelectedId(roleRes.data.rows[0].id);
    setLoading(false);
  }

  useEffect(() => {
    loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每個角色掛咗幾多個帳號——純顯示層，喺呢頁本地 count，唔加新 API 欄。
  const accountCountByRole = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) m.set(u.role_id, (m.get(u.role_id) ?? 0) + 1);
    return m;
  }, [users]);

  async function loadMatrix(roleId: string) {
    setMatrixLoading(true);
    setError(null);
    setDirty(new Map());
    const res = await apiGet<PermissionsResponse>(`/api/roles/${roleId}/permissions`);
    if (!res.ok) {
      setError(res.message);
      setMatrix(null);
      setMatrixLoading(false);
      return;
    }
    setMatrix(res.data);
    setMatrixLoading(false);
  }

  useEffect(() => {
    if (selectedId) loadMatrix(selectedId);
  }, [selectedId]);

  function cellKey(mod: Module, action: Action): string {
    return `${mod}:${action}`;
  }

  function cellValue(mod: Module, action: Action): { granted: boolean; hardDenied: boolean } {
    const k = cellKey(mod, action);
    if (dirty.has(k)) return { granted: dirty.get(k)!, hardDenied: false };
    const cell = matrix?.cells.find((c) => c.module === mod && c.action === action);
    return { granted: cell?.granted ?? false, hardDenied: cell?.hard_denied ?? false };
  }

  // A4（Opus 驗收）：「儲存（N 項改動）」嘅 N 之前係 `dirty.size`，但
  // `dirty` 淨係記「撳過」而唔係「同原值唔同」——撳兩下（開咗又閂返）
  // 都會令 dirty 有一條記錄，N 就會多計一格根本冇改嘅嘢。改做同*原值*
  // （`matrix.cells` 入面 API 讀返嚟嘅 `cell.granted`，唔受 dirty 狀態
  // 影響）比對：新值同原值一樣就喺 dirty map 度刪走嗰個 key（等於冚返
  // 原狀），唔一樣先記低——`dirty.size` 先真係「淨改動」數目。
  function toggleCell(mod: Module, action: Action) {
    const cell = matrix?.cells.find((c) => c.module === mod && c.action === action);
    if (!cell || cell.hard_denied) return;
    const k = cellKey(mod, action);
    const current = cellValue(mod, action).granted;
    const next = !current;
    setDirty((d) => {
      const n = new Map(d);
      if (next === cell.granted) {
        n.delete(k);
      } else {
        n.set(k, next);
      }
      return n;
    });
  }

  async function saveMatrix() {
    if (!selectedId || dirty.size === 0) return;
    setSavingMatrix(true);
    setError(null);
    const changes = Array.from(dirty.entries()).map(([k, granted]) => {
      const [module, action] = k.split(":");
      return { module, action, granted };
    });
    const res = await apiPatch(`/api/roles/${selectedId}/permissions`, { changes });
    setSavingMatrix(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(`已更新 ${changes.length} 格權限`);
    await loadMatrix(selectedId);
  }

  async function onCopy(e: React.FormEvent) {
    e.preventDefault();
    setCopying(true);
    setCopyError(null);
    const res = await apiPost<RoleRow>("/api/roles", { source_role_id: copySourceId, name: copyName });
    setCopying(false);
    if (!res.ok) {
      setCopyError(res.message);
      return;
    }
    setCopyName("");
    setNotice(`已建立自訂角色「${res.data.name}」`);
    await loadRoles();
    setSelectedId(res.data.id);
  }

  async function onVoidRole(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/roles/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已作廢");
    if (selectedId === id) setSelectedId(null);
    await loadRoles();
  }

  const selectedRole = roles.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="系統"
        title="角色權限管理"
        subtitle="灰格＝硬性禁止（唔可以開）；其餘格逐個開關，儲存先一齊送出。"
        actions={
          <Button variant="primary" onClick={saveMatrix} disabled={savingMatrix || dirty.size === 0} data-testid="role-save-button">
            {savingMatrix ? "儲存緊…" : `儲存（${dirty.size} 項改動）`}
          </Button>
        }
      />

      {error && <Notice variant="error">{error}</Notice>}
      {notice && <Notice variant="info">{notice}</Notice>}

      {/* 規格觀感修復：README §17 grid 由 `auto-fit minmax(240px,1fr)`
          （寬度夠就左右對半，矩陣卡好迫）改做 `minmax(240px,1fr)
          minmax(0,2fr)`（左 1 右 2，矩陣卡實際分得更闊），1024px 以下
          先疊做一欄。 */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {loading && <div className="p-3 text-sm text-zk-faint">載入緊…</div>}
            {!loading &&
              roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  data-testid="role-list-item"
                  onClick={() => setSelectedId(r.id)}
                  className={`flex w-full items-center justify-between border-b border-[#f1f5f9] px-3.5 py-[11px] text-left text-[13.5px] last:border-b-0 hover:bg-zk-header ${
                    r.id === selectedId ? "bg-zk-primary-tint-soft font-semibold" : "font-normal"
                  }`}
                >
                  <span className="truncate">
                    {uiLabel(r.name)}
                    {r.is_custom && <span className="ml-1 text-xs font-normal text-zk-faint">（自訂）</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-zk-faint">{accountCountByRole.get(r.id) ?? 0} 人</span>
                </button>
              ))}
          </div>

          <form onSubmit={onCopy} className="flex flex-col gap-2 rounded-[10px] border border-zk-border bg-white p-3.5">
            <div className="text-[12.5px] font-semibold text-zk-text">複製角色</div>
            {copyError && <Notice variant="error">{copyError}</Notice>}
            <select className={selectCls} value={copySourceId} onChange={(e) => setCopySourceId(e.target.value)} required>
              <option value="">來源角色</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {uiLabel(r.name)}
                </option>
              ))}
            </select>
            <input className={inputCls} placeholder="新角色名稱，例：夜班主管" value={copyName} onChange={(e) => setCopyName(e.target.value)} required />
            <Button type="submit" variant="secondary" disabled={copying} className="w-full justify-center">
              {copying ? "建立緊…" : "複製"}
            </Button>
          </form>
        </div>

        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto rounded-[10px] border border-zk-border bg-white" style={{ minWidth: 0 }}>
            <div style={{ minWidth: 540 }}>
              {matrixLoading && <div className="p-3.5 text-sm text-zk-faint">載入緊…</div>}
              {!matrixLoading && !matrix && <div className="p-3.5 text-sm text-zk-faint">請先揀角色</div>}
              {!matrixLoading && matrix && selectedRole && (
                <>
                  <div className="flex items-baseline gap-2.5 border-b border-zk-border px-4 py-3">
                    <span className="text-[15px] font-bold text-zk-text">{uiLabel(selectedRole.name)}</span>
                    <span className="text-[12px] text-zk-muted">
                      {selectedRole.is_custom ? "自訂角色" : "系統預設角色"} · {accountCountByRole.get(selectedRole.id) ?? 0} 個帳號
                    </span>
                    {selectedRole.is_custom && !selectedRole.voided_at && (
                      <ConfirmVoidButton confirmLabel="確認作廢" onConfirm={(reason) => onVoidRole(selectedRole.id, reason)} className="ml-auto" />
                    )}
                  </div>

                  <div className="flex border-b border-zk-border bg-zk-header text-[11.5px] font-semibold text-zk-muted">
                    <div className="min-w-[160px] flex-1 whitespace-nowrap px-4 py-[9px]">模組</div>
                    {ACTIONS.map((a) => (
                      <div key={a} className="w-[72px] shrink-0 py-[9px] text-center">
                        {ACTION_LABEL[a]}
                      </div>
                    ))}
                  </div>

                  {MODULES.map((mod) => (
                    <div key={mod} className="flex h-[38px] items-center border-b border-[#f1f5f9] last:border-b-0">
                      <div className="min-w-[160px] flex-1 truncate px-4 text-[13px] text-zk-text" title={moduleLabel(mod)}>
                        {moduleLabel(mod)}
                      </div>
                      {ACTIONS.map((action) => {
                        const { granted, hardDenied } = cellValue(mod, action);
                        return (
                          <div
                            key={action}
                            className={`flex h-[38px] w-[72px] shrink-0 items-center justify-center ${hardDenied ? "bg-zk-surface-2" : ""}`}
                          >
                            <MatrixCheckbox granted={granted} hardDenied={hardDenied} onToggle={() => toggleCell(mod, action)} />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
