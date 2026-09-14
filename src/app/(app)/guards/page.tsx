"use client";
// P2-A：保安員名冊頁（README §08）——換皮，邏輯／API 呼叫全部保留；
// 加「本月更數」欄（GET /api/guards?with_month_shifts=YYYY-MM，additive
// 唯讀參數，見 src/app/api/guards/route.ts）同「搜尋 姓名/工號/電話」
// filter（純前端篩選 rows，唔加新 API）。雞頭登入呢頁本身已經淨係見自
// 己安員（API scopeGuardWhere() 隔離，未改）。
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmt, fmtDate, isExpired, isExpiringSoon, currentMonthStr } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";

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
  month_shift_count?: number;
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

function matchesSearch(g: GuardRow, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return [g.name_zh, g.staff_no, g.tel].some((v) => v && String(v).toLowerCase().includes(needle));
}

export default function GuardsPage() {
  const [rows, setRows] = useState<GuardRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasMoneyField, setHasMoneyField] = useState(true);
  const [search, setSearch] = useState("");
  // S3（Opus 驗收修復）：原本冇 setter，月份寫死；而家加返 setter＋月份
  // FilterChip，改月份要重新 fetch `with_month_shifts`（見下面 useEffect
  // dep）。
  const [month, setMonth] = useState(currentMonthStr());

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const [guardRes, brokerRes] = await Promise.all([
      apiGet<ApiListResult<GuardRow>>(`/api/guards?take=500&with_month_shifts=${month}`),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  function broker(id?: string | null): BrokerRow | undefined {
    if (!id) return undefined;
    return brokers.find((x) => x.id === id);
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

  function statusPill(g: GuardRow) {
    if (!g.staff_no) return <Pill variant="warning">未有工號</Pill>;
    if (g.status === "active") return <Pill variant="success">在職</Pill>;
    return <Pill variant="neutral">{g.status}</Pill>;
  }

  const visibleRows = rows.filter((r) => matchesSearch(r, search));
  // S2：加返「聘用形式」欄——8 欄變 9 欄。
  const colCount = 9;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="主檔"
        title="保安員"
        subtitle="許可證 60 日內到期或已過期嘅列會高亮。"
        actions={
          <>
            <FilterChip label="搜尋" showCaret={false}>
              <input type="text" placeholder="姓名 / 工號 / 電話" value={search} onChange={(e) => setSearch(e.target.value)} className="w-36" />
            </FilterChip>
            <FilterChip label="本月更數月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <Button variant="primary" onClick={openCreate}>
              新增保安員
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!loading && visibleRows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState
            title={search ? "搵唔到符合嘅保安員" : "暫時冇保安員"}
            description={search ? "試下改搜尋字眼（姓名／工號／電話）。" : "撳右上「新增保安員」開始建立名冊。"}
          />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>姓名</th>
                  <th className={tableCls.th}>工號</th>
                  <th className={tableCls.th}>雞頭</th>
                  <th className={tableCls.th}>電話</th>
                  <th className={tableCls.th}>聘用形式</th>
                  <th className={tableCls.thNum}>本月更數</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.th}>許可證到期</th>
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
                {visibleRows.map((r) => {
                  const expired = isExpired(r.sia_permit_expiry);
                  const expiring = !expired && isExpiringSoon(r.sia_permit_expiry);
                  const b = broker(r.default_broker_id);
                  return (
                    <tr key={r.id} className={`${tableCls.rowHover} ${expired ? tableCls.warnRow : ""}`}>
                      <td className={`${tableCls.td} font-medium`}>{r.name_zh}</td>
                      <td className={tableCls.td}>{fmt(r.staff_no)}</td>
                      <td className={tableCls.td}>
                        {b ? (
                          <Pill variant="broker" color={brokerColor(b.code)}>
                            {b.name}
                          </Pill>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>{fmt(r.tel)}</td>
                      <td className={tableCls.tdMuted}>{fmt(r.employment_type)}</td>
                      <td className={tableCls.tdNum}>{r.month_shift_count ?? "—"}</td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1">
                          {statusPill(r)}
                          {expired && <span className="text-[11px] font-semibold text-[#dc2626]">已過期</span>}
                          {expiring && <span className="text-[11px] font-semibold text-[#c2410c]">快到期</span>}
                        </div>
                      </td>
                      <td className={tableCls.td}>{fmtDate(r.sia_permit_expiry)}</td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                            編輯
                          </button>
                          {r.status === "inactive" ? (
                            <button
                              type="button"
                              onClick={() => onUnvoid(r.id)}
                              className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700 hover:bg-green-50"
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

          <div className="space-y-2 sm:hidden">
            {visibleRows.map((r) => {
              const expired = isExpired(r.sia_permit_expiry);
              const expiring = !expired && isExpiringSoon(r.sia_permit_expiry);
              const b = broker(r.default_broker_id);
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${expired ? "bg-[#fef2f2]" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{r.name_zh}</span>
                    <span className="text-[13px] tabular-nums text-zk-text">{r.month_shift_count ?? "—"} 更</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zk-muted">
                    <span>{fmt(r.staff_no)}</span>
                    <span>{fmt(r.tel)}</span>
                    <span>{fmt(r.employment_type)}</span>
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                    {statusPill(r)}
                    {expired && <span className="font-semibold text-[#dc2626]">已過期</span>}
                    {expiring && <span className="font-semibold text-[#c2410c]">快到期</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                      編輯
                    </button>
                    {r.status === "inactive" ? (
                      <button type="button" onClick={() => onUnvoid(r.id)} className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700">
                        恢復
                      </button>
                    ) : (
                      <ConfirmVoidButton confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

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
