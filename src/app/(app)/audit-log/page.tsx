"use client";
import { useEffect, useState } from "react";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { inputCls, btnSecondary } from "@/components/ui/Field";
import { fmtDateTime } from "@/lib/ui/format";

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  table_name: string;
  row_id: string;
  action: string;
  before: unknown;
  after: unknown;
  ip?: string | null;
  created_at: string;
}
interface UserRow {
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [tableName, setTableName] = useState("");
  const [rowId, setRowId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) });
    if (tableName) qs.set("table_name", tableName);
    if (rowId) qs.set("row_id", rowId);
    const res = await apiGet<ApiListResult<AuditLogRow>>(`/api/audit-log?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setTotal(res.data.total);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);

  useEffect(() => {
    // 用戶名對照——盡力而為，冇「用戶管理:view」就攞唔到，靜靜哋跌返用 id。
    apiGet<ApiListResult<UserRow>>("/api/users?take=500&include_inactive=1").then((res) => {
      if (res.ok) setUsers(Object.fromEntries(res.data.rows.map((u) => [u.id, u.name])));
    });
  }, []);

  function onFilterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSkip(0);
    load();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">操作紀錄</h1>
        <p className="text-sm text-gray-500">只讀——寫入一律由各 API 內部觸發。</p>
      </div>

      <Banner kind="error" message={error} />

      <form onSubmit={onFilterSubmit} className="flex flex-wrap gap-2">
        <input className={inputCls + " max-w-[180px]"} placeholder="table_name" value={tableName} onChange={(e) => setTableName(e.target.value)} />
        <input className={inputCls + " max-w-[220px]"} placeholder="row_id" value={rowId} onChange={(e) => setRowId(e.target.value)} />
        <button type="submit" className={btnSecondary}>
          篩選
        </button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">時間</th>
              <th className="px-3 py-2">操作人</th>
              <th className="px-3 py-2">資料表</th>
              <th className="px-3 py-2">Row ID</th>
              <th className="px-3 py-2">動作</th>
              <th className="px-3 py-2">內容</th>
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
                  暫時冇紀錄
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.actor_user_id ? (users[r.actor_user_id] ?? r.actor_user_id.slice(0, 8)) : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.table_name}</td>
                <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.row_id.slice(0, 12)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.action}</td>
                <td className="px-3 py-2">
                  <details>
                    <summary className="cursor-pointer text-xs text-blue-600">展開 before/after</summary>
                    <div className="mt-1 space-y-1">
                      <pre className="max-w-md overflow-x-auto rounded bg-gray-50 p-2 text-[11px]">before: {JSON.stringify(r.before, null, 2)}</pre>
                      <pre className="max-w-md overflow-x-auto rounded bg-gray-50 p-2 text-[11px]">after: {JSON.stringify(r.after, null, 2)}</pre>
                    </div>
                  </details>
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
    </div>
  );
}
