"use client";
// P2-A：價目頁（README §10）——換皮，邏輯／API 呼叫、權限遮蔽
// （hasClientRate/hasPayoutRate 判斷唔變）全部保留。
import { useEffect, useState } from "react";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate, fmtMoney } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";

const BILLING_MODELS = ["per_shift", "monthly_fixed", "admin_fee", "special"] as const;
const PAGE_SIZE = 50;

interface RateCardRow {
  id: string;
  site_id: string;
  shift_type_id?: string | null;
  broker_id?: string | null;
  guard_id?: string | null;
  client_rate?: string | number | null;
  guard_wage?: string | number | null;
  broker_fee?: string | number | null;
  payout_rate?: string | number | null;
  billing_model?: string | null;
  effective_from: string;
  effective_to?: string | null;
  note?: string | null;
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
interface GuardRow {
  id: string;
  staff_no?: string | null;
  name_zh: string;
}

const emptyForm = {
  site_id: "",
  shift_type_id: "",
  broker_id: "",
  guard_id: "",
  client_rate: "",
  guard_wage: "",
  broker_fee: "",
  payout_rate: "",
  billing_model: "",
  effective_from: "",
  effective_to: "",
  note: "",
};

export default function RateCardsPage() {
  const [rows, setRows] = useState<RateCardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [siteFilter, setSiteFilter] = useState("");
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [shiftTypes, setShiftTypes] = useState<ShiftTypeRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [guards, setGuards] = useState<GuardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasClientRate, setHasClientRate] = useState(true);
  const [hasPayoutRate, setHasPayoutRate] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) });
    if (siteFilter) qs.set("site_id", siteFilter);
    const res = await apiGet<ApiListResult<RateCardRow>>(`/api/rate-cards?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setTotal(res.data.total);
    setHasClientRate(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "client_rate" in r));
    setHasPayoutRate(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "payout_rate" in r));
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteFilter, skip]);

  useEffect(() => {
    (async () => {
      const [siteRes, brokerRes, guardRes] = await Promise.all([
        apiGet<ApiListResult<SiteRow>>("/api/sites?take=500"),
        apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
        apiGet<ApiListResult<GuardRow>>("/api/guards?take=500"),
      ]);
      if (siteRes.ok) setSites(siteRes.data.rows);
      if (brokerRes.ok) setBrokers(brokerRes.data.rows);
      if (guardRes.ok) setGuards(guardRes.data.rows);
    })();
  }, []);

  useEffect(() => {
    if (!form.site_id) {
      setShiftTypes([]);
      return;
    }
    apiGet<ApiListResult<ShiftTypeRow>>(`/api/shift-types?site_id=${form.site_id}&take=500`).then((res) => {
      if (res.ok) setShiftTypes(res.data.rows);
    });
  }, [form.site_id]);

  function siteLabel(id: string): string {
    return sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8);
  }
  function shiftType(id?: string | null): ShiftTypeRow | undefined {
    if (!id) return undefined;
    return shiftTypes.find((s) => s.id === id);
  }
  function broker(id?: string | null): BrokerRow | undefined {
    if (!id) return undefined;
    return brokers.find((x) => x.id === id);
  }
  function guardLabel(id?: string | null): string {
    if (!id) return "通用";
    const g = guards.find((x) => x.id === id);
    return g ? g.name_zh : id.slice(0, 8);
  }

  function openCreate() {
    setForm({ ...emptyForm, site_id: siteFilter || "" });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const body: Record<string, unknown> = {
      site_id: form.site_id,
      shift_type_id: form.shift_type_id || undefined,
      broker_id: form.broker_id || undefined,
      guard_id: form.guard_id || undefined,
      guard_wage: form.guard_wage ? Number(form.guard_wage) : undefined,
      broker_fee: form.broker_fee ? Number(form.broker_fee) : undefined,
      billing_model: form.billing_model || undefined,
      effective_from: form.effective_from,
      effective_to: form.effective_to || undefined,
      note: form.note || undefined,
    };
    if (hasClientRate && form.client_rate !== "") body.client_rate = Number(form.client_rate);
    if (hasPayoutRate && form.payout_rate !== "") body.payout_rate = Number(form.payout_rate);

    const res = await apiPost("/api/rate-cards", body);
    setSaving(false);
    if (!res.ok) {
      setFormError(res.message);
      return;
    }
    setDrawerOpen(false);
    setNotice("已新增");
    await load();
  }

  async function onVoid(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/rate-cards/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已作廢");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/rate-cards/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已解除作廢");
    await load();
  }

  const colCount = 10;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="主檔"
        title="價目"
        subtitle="每個盤每個更別每個雞頭嘅價；冇權睇嘅欄顯示「—」。"
        actions={
          <>
            <FilterChip label="盤">
              <select
                value={siteFilter}
                onChange={(e) => {
                  setSiteFilter(e.target.value);
                  setSkip(0);
                }}
              >
                <option value="">全部盤</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.canonical_name}
                  </option>
                ))}
              </select>
            </FilterChip>
            <Button variant="primary" onClick={openCreate}>
              新增價目
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!loading && rows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title="暫時冇價目紀錄" description="撳右上「新增價目」開始建立收客價／出街價。" cta={<Button variant="primary" onClick={openCreate}>新增價目</Button>} />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>更別</th>
                  <th className={tableCls.th}>雞頭</th>
                  <th className={tableCls.th}>保安員</th>
                  <th className={tableCls.thNum}>收客價</th>
                  <th className={tableCls.thNum}>出街價</th>
                  <th className={tableCls.thNum}>保安員工資</th>
                  <th className={tableCls.thNum}>雞頭費</th>
                  <th className={tableCls.th}>生效期</th>
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
                      <td className={`${tableCls.td} font-medium`}>{siteLabel(r.site_id)}</td>
                      <td className={tableCls.td}>
                        {st ? (
                          <Pill variant="broker" color={shiftCodeStyle(st.code)}>
                            {st.code}
                          </Pill>
                        ) : (
                          <Pill variant="neutral">通用</Pill>
                        )}
                      </td>
                      <td className={tableCls.td}>
                        {b ? (
                          <Pill variant="broker" color={brokerColor(b.code)}>
                            {b.name}
                          </Pill>
                        ) : (
                          "通用"
                        )}
                      </td>
                      <td className={tableCls.td}>{guardLabel(r.guard_id)}</td>
                      <td className={tableCls.tdNum}>{hasClientRate ? fmtMoney(r.client_rate) : "—"}</td>
                      <td className={tableCls.tdNum}>{hasPayoutRate ? fmtMoney(r.payout_rate) : "—"}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(r.guard_wage)}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(r.broker_fee)}</td>
                      <td className={tableCls.tdMuted}>
                        {fmtDate(r.effective_from)} – {r.effective_to ? fmtDate(r.effective_to) : "無限期"}
                      </td>
                      <td className={tableCls.td}>
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 sm:hidden">
            {rows.map((r) => {
              const st = shiftType(r.shift_type_id);
              const b = broker(r.broker_id);
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${r.voided_at ? "opacity-45" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{siteLabel(r.site_id)}</span>
                    <span className="text-[13px] tabular-nums text-zk-text">{hasClientRate ? fmtMoney(r.client_rate) : "—"}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zk-muted">
                    {st ? (
                      <Pill variant="broker" color={shiftCodeStyle(st.code)}>
                        {st.code}
                      </Pill>
                    ) : (
                      <Pill variant="neutral">通用</Pill>
                    )}
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                    <span>{guardLabel(r.guard_id)}</span>
                  </div>
                  <div className="mt-1 text-[11.5px] text-zk-muted">
                    出街 {hasPayoutRate ? fmtMoney(r.payout_rate) : "—"} · 生效 {fmtDate(r.effective_from)}–{r.effective_to ? fmtDate(r.effective_to) : "無限期"}
                  </div>
                  <div className="mt-2">
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

          <div className="flex items-center justify-between text-[12.5px] text-zk-muted">
            <span>
              共 {total} 條，第 {Math.floor(skip / PAGE_SIZE) + 1} 頁
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={skip === 0} onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}>
                上一頁
              </Button>
              <Button variant="secondary" disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip((s) => s + PAGE_SIZE)}>
                下一頁
              </Button>
            </div>
          </div>
        </>
      )}

      <Drawer open={drawerOpen} title="新增價目" onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="盤">
            <select className={selectCls} value={form.site_id} onChange={(e) => setForm((f) => ({ ...f, site_id: e.target.value, shift_type_id: "" }))} required>
              <option value="">請選擇</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="更別" hint="留空＝通用">
            <select className={selectCls} value={form.shift_type_id} onChange={(e) => setForm((f) => ({ ...f, shift_type_id: e.target.value }))}>
              <option value="">（通用）</option>
              {shiftTypes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="雞頭" hint="留空＝通用">
            <select className={selectCls} value={form.broker_id} onChange={(e) => setForm((f) => ({ ...f, broker_id: e.target.value }))}>
              <option value="">（通用）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="保安員" hint="留空＝通用">
            <select className={selectCls} value={form.guard_id} onChange={(e) => setForm((f) => ({ ...f, guard_id: e.target.value }))}>
              <option value="">（通用）</option>
              {guards.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name_zh}
                  {g.staff_no ? `（${g.staff_no}）` : ""}
                </option>
              ))}
            </select>
          </Field>
          {hasClientRate && (
            <Field label="收客價（client_rate）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.client_rate}
                onChange={(e) => setForm((f) => ({ ...f, client_rate: e.target.value }))}
              />
            </Field>
          )}
          <Field label="保安員工資（guard_wage）">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={form.guard_wage}
              onChange={(e) => setForm((f) => ({ ...f, guard_wage: e.target.value }))}
            />
          </Field>
          <Field label="雞頭費（broker_fee）">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={form.broker_fee}
              onChange={(e) => setForm((f) => ({ ...f, broker_fee: e.target.value }))}
            />
          </Field>
          {hasPayoutRate && (
            <Field label="出街價（payout_rate）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.payout_rate}
                onChange={(e) => setForm((f) => ({ ...f, payout_rate: e.target.value }))}
              />
            </Field>
          )}
          <Field label="結算模式（billing_model）">
            <select className={selectCls} value={form.billing_model} onChange={(e) => setForm((f) => ({ ...f, billing_model: e.target.value }))}>
              <option value="">（沿用盤設定）</option>
              {BILLING_MODELS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="生效日期">
              <input
                type="date"
                className={inputCls}
                value={form.effective_from}
                onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))}
                required
              />
            </Field>
            <Field label="失效日期" hint="留空＝無限期">
              <input
                type="date"
                className={inputCls}
                value={form.effective_to}
                onChange={(e) => setForm((f) => ({ ...f, effective_to: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="備註">
            <input className={inputCls} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
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
