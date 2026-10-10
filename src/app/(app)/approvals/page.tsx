"use client";
// P2-A：審批隊列頁（README §06）——換皮，邏輯／API 呼叫全部保留。
// 注意：「全選＋批准」primary 掣要留喺表格之前（DOM 順序）——
// tests/e2e/wp3.spec.ts (b) 用 `getByRole("button",{name:"批准"}).first()`
// 撳掣（substring match，個 bulk 掣個名都含「批准」二字），原本行為
// 就係揀中呢個 bulk 掣，唔可以因為換皮打亂順序。
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import { kickerFor } from "@/lib/nav/schema";

interface ShiftRecordRow {
  id: string;
  work_date: string;
  site_id: string;
  shift_type_id: string;
  guard_id: string;
  status: string;
  record_type?: string;
  leave_code?: string | null;
  settlement_broker_id?: string | null;
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
interface BrokerRow {
  id: string;
  code: string;
  name: string;
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ShiftRecordRow[]>([]);
  const [sites, setSites] = useState<Record<string, SiteRow>>({});
  const [guards, setGuards] = useState<Record<string, GuardRow>>({});
  const [shiftTypes, setShiftTypes] = useState<Record<string, ShiftTypeRow>>({});
  const [brokers, setBrokers] = useState<Record<string, BrokerRow>>({});
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
    const [siteList, guardList, shiftTypeList, brokerList] = await Promise.all([
      cachedGetAll<SiteRow>("/api/sites"),
      cachedGetAll<GuardRow>("/api/guards?fields=lite&include_inactive=1"),
      cachedGetAll<ShiftTypeRow>("/api/shift-types?include_voided=1"),
      cachedGetAll<BrokerRow>("/api/brokers?include_inactive=1"),
    ]);
    if (siteList.ok) setSites(Object.fromEntries(siteList.data.rows.filter((s) => siteIds.includes(s.id)).map((s) => [s.id, s])));
    if (guardList.ok) setGuards(Object.fromEntries(guardList.data.rows.filter((g) => guardIds.includes(g.id)).map((g) => [g.id, g])));
    if (shiftTypeList.ok)
      setShiftTypes(Object.fromEntries(shiftTypeList.data.rows.filter((s) => shiftTypeIds.includes(s.id)).map((s) => [s.id, s])));
    if (brokerList.ok) setBrokers(Object.fromEntries(brokerList.data.rows.map((b) => [b.id, b])));
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

  function typePill(r: ShiftRecordRow) {
    if (r.leave_code) {
      return <Pill variant="warning">請假 · {r.leave_code}</Pill>;
    }
    return <Pill variant="shift">新排更</Pill>;
  }

  // P2-A 驗收修復：頭列實際係 7 欄（日期/盤/更別/保安員/類型/雞頭/操
  // 作）——原本寫死 6，令 tableMinWidth() 算窄咗、要靠落面 colSpan
  // 「+1」補返，兩個問題一齊執:colCount 改返啱數，colSpan 直接用
  // colCount（唔再 +1）。
  const colCount = 7;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/approvals")}
        title="審批隊列"
        subtitle="雞頭排嘅更逐項確認（draft → confirmed）或者打返轉頭。"
        actions={
          <>
            <FilterChip label="盤">
              <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
                <option value="">全部盤</option>
                {siteOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.canonical_name}
                  </option>
                ))}
              </select>
            </FilterChip>
            <Button variant="primary" onClick={approveAll} disabled={bulkBusy || rows.length === 0}>
              {bulkBusy ? "批准緊…" : `全選 ＋ 批准（${rows.length}）`}
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!loading && rows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title="暫時冇待審項目" description="雞頭排嘅新更／請假會喺呢度逐項出現，等緊審批。" />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>日期</th>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>更別</th>
                  <th className={tableCls.th}>保安員</th>
                  <th className={tableCls.th}>類型</th>
                  <th className={tableCls.th}>雞頭</th>
                  <th className={tableCls.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td className={tableCls.tdMuted} colSpan={colCount}>
                      載入緊…
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const busy = busyIds.has(r.id);
                  const guard = guards[r.guard_id];
                  const st = shiftTypes[r.shift_type_id];
                  const b = r.settlement_broker_id ? brokers[r.settlement_broker_id] : undefined;
                  return (
                    <tr key={r.id} className={tableCls.rowHover}>
                      <td className={tableCls.td}>{fmtDate(r.work_date)}</td>
                      <td className={`${tableCls.td} font-medium`}>{sites[r.site_id]?.canonical_name ?? r.site_id.slice(0, 8)}</td>
                      <td className={tableCls.td}>
                        {st ? (
                          <Pill variant="broker" color={shiftCodeStyle(st.code)}>
                            {st.code}
                          </Pill>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>
                        {guard ? (
                          <>
                            {guard.name_zh}
                            {guard.staff_no && <span className="ml-1 text-zk-xs text-zk-faint">（{guard.staff_no}）</span>}
                          </>
                        ) : (
                          r.guard_id.slice(0, 8)
                        )}
                      </td>
                      <td className={tableCls.td}>{typePill(r)}</td>
                      <td className={tableCls.td}>
                        {b ? (
                          <Pill variant="broker" color={brokerColor(b.code)}>
                            {b.name}
                          </Pill>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>
                        {rejectingId === r.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              placeholder="退回原因"
                              className="w-36 rounded border border-zk-input-border px-2 py-1 text-xs"
                            />
                            <Button variant="dangerSolid" size="sm"
                              type="button"
                              disabled={busy || !rejectReason.trim()}
                              onClick={() => reject(r.id, rejectReason.trim())}
                             
                            >
                              確認退回
                            </Button>
                            <Button variant="ghost" size="sm"
                              type="button"
                              onClick={() => {
                                setRejectingId(null);
                                setRejectReason("");
                              }}
                             
                            >
                              取消
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-1.5">
                            <Button variant="danger" size="sm"
                              type="button"
                              disabled={busy}
                              onClick={() => setRejectingId(r.id)}
                             
                            >
                              退回
                            </Button>
                            <Button variant="primary" size="sm"
                              type="button"
                              disabled={busy}
                              onClick={() => approve(r.id)}
                             
                            >
                              批准
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 sm:hidden">
            {rows.map((r) => {
              const busy = busyIds.has(r.id);
              const guard = guards[r.guard_id];
              const st = shiftTypes[r.shift_type_id];
              const b = r.settlement_broker_id ? brokers[r.settlement_broker_id] : undefined;
              return (
                <div key={r.id} className="rounded-lg border border-zk-border bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zk-base font-medium text-zk-text">
                      {sites[r.site_id]?.canonical_name ?? r.site_id.slice(0, 8)}
                    </span>
                    <span className="text-zk-base text-zk-text">{fmtDate(r.work_date)}</span>
                  </div>
                  <div className="mt-1 text-zk-xs text-zk-muted">
                    {guard ? (
                      <>
                        {guard.name_zh}
                        {guard.staff_no && <span className="ml-1">（{guard.staff_no}）</span>}
                      </>
                    ) : (
                      r.guard_id.slice(0, 8)
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {st && (
                      <Pill variant="broker" color={shiftCodeStyle(st.code)}>
                        {st.code}
                      </Pill>
                    )}
                    {typePill(r)}
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                  </div>
                  {rejectingId === r.id ? (
                    <div className="mt-2 flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="退回原因"
                        className="w-full rounded border border-zk-input-border px-2 py-1 text-xs"
                      />
                      <Button variant="dangerSolid" size="sm" className="shrink-0"
                        type="button"
                        disabled={busy || !rejectReason.trim()}
                        onClick={() => reject(r.id, rejectReason.trim())}
                       
                      >
                        確認退回
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex gap-1.5">
                      <Button variant="danger" size="sm"
                        type="button"
                        disabled={busy}
                        onClick={() => setRejectingId(r.id)}
                       
                      >
                        退回
                      </Button>
                      <Button variant="primary" size="sm"
                        type="button"
                        disabled={busy}
                        onClick={() => approve(r.id)}
                       
                      >
                        批准
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
