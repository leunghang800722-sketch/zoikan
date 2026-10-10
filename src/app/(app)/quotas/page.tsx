"use client";
// P2-A：配額頁（README §05）——換皮，邏輯／API 呼叫全部保留。
import { useEffect, useState } from "react";
import { apiGet, apiGetAll, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate, currentMonthStr } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";

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

const emptyForm = { month: currentMonthStr(), site_id: "", shift_type_id: "", broker_id: "", target_shifts: "" };

export default function QuotasPage() {
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [shiftTypes, setShiftTypes] = useState<ShiftTypeRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [siteFilter, setSiteFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState(currentMonthStr());
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
        apiGetAll<SiteRow>("/api/sites"),
        apiGetAll<BrokerRow>("/api/brokers"),
        apiGetAll<ShiftTypeRow>("/api/shift-types"),
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
  function shiftType(id: string): ShiftTypeRow | undefined {
    return shiftTypes.find((s) => s.id === id);
  }
  function broker(id: string): BrokerRow | undefined {
    return brokers.find((b) => b.id === id);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ ...emptyForm, site_id: siteFilter, month: monthFilter || currentMonthStr() });
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

  const colCount = 6;
  const emptyDescription = "呢個月未有任何雞頭配額——配額係軟性限制，超額會喺更表提示但唔會擋儲存。";

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="排更"
        title="配額"
        subtitle="雞頭每月每盤每更別可排幾多更 — 軟性限制，超額會提示但唔會封。"
        actions={
          <>
            <FilterChip label="盤">
              <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
                <option value="">全部盤</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.canonical_name}
                  </option>
                ))}
              </select>
            </FilterChip>
            <FilterChip label="月份" showCaret={false}>
              <input type="month" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
            </FilterChip>
            <Button variant="primary" onClick={openCreate}>
              新增配額
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      <EmptyMonthNotice month={monthFilter} isEmpty={!loading && rows.length === 0} onJump={setMonthFilter} />

      {!loading && rows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState
            title={`${monthFilter || "本月"} 未設任何配額`}
            description={emptyDescription}
            cta={
              <Button variant="primary" onClick={openCreate}>
                新增配額
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {/* 桌面／平板：表格。 */}
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>月份</th>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>更別</th>
                  <th className={tableCls.th}>雞頭</th>
                  <th className={tableCls.thNum}>目標更數</th>
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
                  const st = shiftType(r.shift_type_id);
                  const b = broker(r.broker_id);
                  return (
                    <tr key={r.id} className={`${tableCls.rowHover} ${r.voided_at ? "opacity-45" : ""}`}>
                      <td className={tableCls.td}>{fmtDate(r.month)}</td>
                      <td className={`${tableCls.td} font-medium`}>{siteLabel(r.site_id)}</td>
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
                        {b ? (
                          <Pill variant="broker" color={brokerColor(b.code)}>
                            {b.name}
                          </Pill>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.tdNum}>{r.target_shifts}</td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                            編輯
                          </button>
                          {r.voided_at ? (
                            <button
                              type="button"
                              onClick={() => onUnvoid(r.id)}
                              className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700 hover:bg-green-50"
                            >
                              解除作廢
                            </button>
                          ) : (
                            <ConfirmVoidButton onConfirm={(reason) => onVoid(r.id, reason)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 手機（&lt;640）：列表卡。其他（Opus 驗收）：loading 嗰陣桌面
              table 有「載入緊…」提示列，手機卡舊版冇——加返，唔好淨係
              一片空白。 */}
          <div className="space-y-2 sm:hidden">
            {loading && <div className="rounded-lg border border-zk-border bg-white p-3 text-center text-[13px] text-zk-muted">載入緊…</div>}
            {rows.map((r) => {
              const st = shiftType(r.shift_type_id);
              const b = broker(r.broker_id);
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${r.voided_at ? "opacity-45" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{siteLabel(r.site_id)}</span>
                    <span className="text-[13px] tabular-nums text-zk-text">{r.target_shifts} 更</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zk-muted">
                    <span>{fmtDate(r.month)}</span>
                    {st && (
                      <Pill variant="broker" color={shiftCodeStyle(st.code)}>
                        {st.code}
                      </Pill>
                    )}
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                      編輯
                    </button>
                    {r.voided_at ? (
                      <button type="button" onClick={() => onUnvoid(r.id)} className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700">
                        解除作廢
                      </button>
                    ) : (
                      <ConfirmVoidButton onConfirm={(reason) => onVoid(r.id, reason)} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

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
