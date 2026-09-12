"use client";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { fmtDate } from "@/lib/ui/format";

interface ShiftRecordRow {
  id: string;
  work_date: string;
  site_id: string;
  shift_type_id: string;
  guard_id: string;
  status: string;
  record_type?: string;
  leave_code?: string | null;
}
interface SiteRow {
  id: string;
  canonical_name: string;
}
interface GuardRow {
  id: string;
  staff_no?: string;
  name_zh: string;
}
interface ShiftTypeRow {
  id: string;
  code: string;
  label?: string;
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ShiftRecordRow[]>([]);
  const [sites, setSites] = useState<Record<string, SiteRow>>({});
  const [guards, setGuards] = useState<Record<string, GuardRow>>({});
  const [shiftTypes, setShiftTypes] = useState<Record<string, ShiftTypeRow>>({});
  const [siteFilter, setSiteFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ status: "pending_approval", take: "500" });
    if (siteFilter) qs.set("site_id", siteFilter);
    const res = await apiGet<ApiListResult<ShiftRecordRow>>(`/api/shift-records?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);

    const siteIds = Array.from(new Set(res.data.rows.map((r) => r.site_id)));
    const guardIds = Array.from(new Set(res.data.rows.map((r) => r.guard_id)));
    const shiftTypeIds = Array.from(new Set(res.data.rows.map((r) => r.shift_type_id)));
    const [siteList, guardList, shiftTypeList] = await Promise.all([
      apiGet<ApiListResult<SiteRow>>("/api/sites?take=500"),
      apiGet<ApiListResult<GuardRow>>("/api/guards?take=500&include_inactive=1"),
      apiGet<ApiListResult<ShiftTypeRow>>("/api/shift-types?take=500&include_voided=1"),
    ]);
    if (siteList.ok) setSites(Object.fromEntries(siteList.data.rows.filter((s) => siteIds.includes(s.id)).map((s) => [s.id, s])));
    if (guardList.ok) setGuards(Object.fromEntries(guardList.data.rows.filter((g) => guardIds.includes(g.id)).map((g) => [g.id, g])));
    if (shiftTypeList.ok)
      setShiftTypes(Object.fromEntries(shiftTypeList.data.rows.filter((s) => shiftTypeIds.includes(s.id)).map((s) => [s.id, s])));
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteFilter]);

  const siteOptions = useMemo(() => Object.values(sites).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)), [sites]);

  async function approve(id: string) {
    setBusyIds((s) => new Set(s).add(id));
    setError(null);
    const res = await apiPost(`/api/shift-records/${id}/approve`);
    setBusyIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  async function reject(id: string, reason: string) {
    setBusyIds((s) => new Set(s).add(id));
    setError(null);
    const res = await apiPost(`/api/shift-records/${id}/reject`, { reason });
    setBusyIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows((rs) => rs.filter((r) => r.id !== id));
    setRejectingId(null);
    setRejectReason("");
  }

  async function approveAll() {
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    let okCount = 0;
    let failCount = 0;
    for (const r of rows) {
      const res = await apiPost(`/api/shift-records/${r.id}/approve`);
      if (res.ok) okCount += 1;
      else failCount += 1;
    }
    setBulkBusy(false);
    setNotice(`已批准 ${okCount} 條${failCount > 0 ? `，${failCount} 條失敗（可能已被處理）` : ""}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">審批隊列</h1>
          <p className="text-sm text-gray-500">雞頭排更逐項確認——批准後轉 confirmed，退回打返 draft。</p>
        </div>
        <button
          type="button"
          onClick={approveAll}
          disabled={bulkBusy || rows.length === 0}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {bulkBusy ? "批准緊…" : `全選＋批准（${rows.length}）`}
        </button>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <select
        className="rounded border border-gray-300 px-3 py-1.5 text-sm"
        value={siteFilter}
        onChange={(e) => setSiteFilter(e.target.value)}
      >
        <option value="">全部盤</option>
        {siteOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.canonical_name}
          </option>
        ))}
      </select>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">日期</th>
              <th className="px-3 py-2">盤</th>
              <th className="px-3 py-2">更別</th>
              <th className="px-3 py-2">保安員</th>
              <th className="px-3 py-2">類型</th>
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
                  暫時冇待審項目
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const busy = busyIds.has(r.id);
              const guard = guards[r.guard_id];
              return (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2">{fmtDate(r.work_date)}</td>
                  <td className="px-3 py-2">{sites[r.site_id]?.canonical_name ?? r.site_id.slice(0, 8)}</td>
                  <td className="px-3 py-2">{shiftTypes[r.shift_type_id]?.code ?? r.shift_type_id.slice(0, 8)}</td>
                  <td className="px-3 py-2">{guard ? `${guard.name_zh}${guard.staff_no ? `（${guard.staff_no}）` : ""}` : r.guard_id.slice(0, 8)}</td>
                  <td className="px-3 py-2">{r.leave_code ?? r.record_type ?? "shift"}</td>
                  <td className="px-3 py-2">
                    {rejectingId === r.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="退回原因"
                          className="w-36 rounded border border-gray-300 px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          disabled={busy || !rejectReason.trim()}
                          onClick={() => reject(r.id, rejectReason.trim())}
                          className="rounded bg-red-600 px-2 py-1 text-xs text-white disabled:opacity-50"
                        >
                          確認退回
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(null);
                            setRejectReason("");
                          }}
                          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => approve(r.id)}
                          className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRejectingId(r.id)}
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          退回
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
