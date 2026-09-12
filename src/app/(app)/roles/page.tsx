"use client";
import { uiLabel } from "@/lib/ui/format";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { inputCls, selectCls, btnPrimary } from "@/components/ui/Field";
import { ACTIONS, MODULES, type Action, type Module } from "@/lib/rbac/matrix";

interface RoleRow {
  id: string;
  name: string;
  base_role: string;
  is_custom: boolean;
  payout_approval_limit?: string | number | null;
  voided_at?: string | null;
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

const ACTION_LABEL: Record<Action, string> = { view: "睇", create: "增", update: "改", void: "廢", export: "出" };

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
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
    const res = await apiGet<ApiListResult<RoleRow>>("/api/roles?take=500");
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRoles(res.data.rows);
    if (!selectedId && res.data.rows.length > 0) setSelectedId(res.data.rows[0].id);
    setLoading(false);
  }

  useEffect(() => {
    loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function toggleCell(mod: Module, action: Action) {
    const cell = matrix?.cells.find((c) => c.module === mod && c.action === action);
    if (!cell || cell.hard_denied) return;
    const k = cellKey(mod, action);
    const current = cellValue(mod, action).granted;
    setDirty((d) => {
      const n = new Map(d);
      n.set(k, !current);
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
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">角色權限管理</h1>
        <p className="text-sm text-gray-500">灰底格＝硬性禁止（唔可以開）；其餘格可以逐個開關，儲存先一齊送出。</p>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="flex gap-4">
        <div className="w-56 shrink-0 space-y-3">
          <div className="rounded-lg border border-gray-200 bg-white">
            {loading && <div className="p-3 text-sm text-gray-400">載入緊…</div>}
            {!loading &&
              roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-gray-50 ${
                    r.id === selectedId ? "bg-gray-100 font-medium" : ""
                  }`}
                >
                  {uiLabel(r.name)}
                  {r.is_custom && <span className="ml-1 text-xs text-gray-400">（自訂）</span>}
                </button>
              ))}
          </div>

          <form onSubmit={onCopy} className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
            <div className="text-sm font-medium text-gray-700">複製角色</div>
            <Banner kind="error" message={copyError} />
            <select className={selectCls} value={copySourceId} onChange={(e) => setCopySourceId(e.target.value)} required>
              <option value="">來源角色</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {uiLabel(r.name)}
                </option>
              ))}
            </select>
            <input className={inputCls} placeholder="新角色名稱" value={copyName} onChange={(e) => setCopyName(e.target.value)} required />
            <button type="submit" disabled={copying} className={btnPrimary + " w-full"}>
              {copying ? "建立緊…" : "複製"}
            </button>
          </form>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {selectedRole && (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900">{selectedRole.name}</div>
                <div className="text-xs text-gray-500">base_role={selectedRole.base_role}</div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={saveMatrix} disabled={savingMatrix || dirty.size === 0} className={btnPrimary}>
                  {savingMatrix ? "儲存緊…" : `儲存（${dirty.size}）`}
                </button>
                {selectedRole.is_custom && !selectedRole.voided_at && (
                  <ConfirmVoidButton confirmLabel="確認作廢" onConfirm={(reason) => onVoidRole(selectedRole.id, reason)} />
                )}
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            {matrixLoading && <div className="p-3 text-sm text-gray-400">載入緊…</div>}
            {!matrixLoading && !matrix && <div className="p-3 text-sm text-gray-400">請先揀角色</div>}
            {!matrixLoading && matrix && (
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5">Module</th>
                    {ACTIONS.map((a) => (
                      <th key={a} className="px-2 py-1.5 text-center">
                        {ACTION_LABEL[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MODULES.map((mod) => (
                    <tr key={mod} className="border-t border-gray-100">
                      <td className="px-2 py-1.5 whitespace-nowrap">{uiLabel(mod)}</td>
                      {ACTIONS.map((action) => {
                        const { granted, hardDenied } = cellValue(mod, action);
                        return (
                          <td key={action} className={`px-2 py-1.5 text-center ${hardDenied ? "bg-gray-100" : ""}`}>
                            <input
                              type="checkbox"
                              checked={granted}
                              disabled={hardDenied}
                              onChange={() => toggleCell(mod, action)}
                              className={hardDenied ? "cursor-not-allowed opacity-40" : "cursor-pointer"}
                              title={hardDenied ? "硬性禁止" : undefined}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
