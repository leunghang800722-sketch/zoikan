"use client";
// P2-A：雞頭管理頁（README §09）——換皮，邏輯／API 呼叫全部保留。
// 「人數」欄係純前端計出嚟：/api/guards 入面 default_broker_id 等於呢
// 個雞頭嘅個數。
// M3（Opus 驗收修復）：「掛邊啲盤」舊版用 /api/referral-fee-rates（呢個
// 表係「幾錢」，唔係「邊個盤有份」，一個雞頭可以喺冇費率行嘅盤都有份）
// 改用真正代表「邊個雞頭喺邊個盤邊個月有份」嘅
// GET /api/broker-site-assignments（已存在，配額前身白名單），按當月
// （currentMonthStr()）過濾，加月份 FilterChip 俾人揀返第啲月。
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
import { fmtMoney, currentMonthStr } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";

const BROKER_KINDS = ["broker", "internal_cash", "internal_longterm", "external", "special"] as const;
const SETTLEMENT_TYPES = ["cash", "autopay", "salary", "none"] as const;

interface BrokerRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  settlement_type: string;
  bank_info?: unknown;
  requires_approval: boolean;
  aliases: string[];
  status: string;
}

const emptyForm = {
  code: "",
  name: "",
  kind: BROKER_KINDS[0] as string,
  settlement_type: SETTLEMENT_TYPES[0] as string,
  bank_info: "",
  requires_approval: false,
  aliases: "",
};

interface ReferralFeeRateRow {
  id: string;
  broker_id: string;
  site_id?: string | null;
  month: string;
  fee_per_shift?: string | number | null;
  voided_at?: string | null;
}
interface SiteRow {
  id: string;
  canonical_name: string;
}
interface GuardRow {
  id: string;
  default_broker_id?: string | null;
}
interface BrokerSiteAssignmentRow {
  id: string;
  broker_id: string;
  site_id: string;
  month: string;
}

const emptyFeeRateForm = { site_id: "", month: "", fee_per_shift: "" };

// P2 規劃判斷（Fable，唔算 README 衝突）：broker.kind 冇喺 README 逐個
// 定義中文名——「外判/公司兵/公司長工」對應 broker/external → 外判，
// internal_cash → 公司兵，internal_longterm → 公司長工；special 冇對應，
// 原字面中性灰顯示。
function kindPill(kind: string) {
  if (kind === "internal_cash") return <Pill variant="shift">公司兵</Pill>;
  if (kind === "internal_longterm") return <Pill variant="shift">公司長工</Pill>;
  if (kind === "broker" || kind === "external") return <Pill variant="neutral">外判</Pill>;
  return <Pill variant="neutral">{kind}</Pill>;
}

export default function BrokersPage() {
  const [rows, setRows] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [feeRatesBroker, setFeeRatesBroker] = useState<BrokerRow | null>(null);
  const [feeRates, setFeeRates] = useState<ReferralFeeRateRow[]>([]);
  const [feeRatesLoading, setFeeRatesLoading] = useState(false);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [hasFeePerShift, setHasFeePerShift] = useState(true);

  const [feeRateDrawerOpen, setFeeRateDrawerOpen] = useState(false);
  const [editingFeeRateId, setEditingFeeRateId] = useState<string | null>(null);
  const [feeRateForm, setFeeRateForm] = useState(emptyFeeRateForm);
  const [feeRateFormError, setFeeRateFormError] = useState<string | null>(null);
  const [feeRateSaving, setFeeRateSaving] = useState(false);

  // README §09「人數」——全公司安員載一次前端數。
  const [guardCountByBroker, setGuardCountByBroker] = useState<Record<string, number>>({});
  // M3：「掛邊啲盤」改用 broker_site_assignments（一次過攞晒，前端按
  // 月份 FilterChip 篩）。
  const [assignments, setAssignments] = useState<BrokerSiteAssignmentRow[]>([]);
  const [month, setMonth] = useState(currentMonthStr());

  async function load() {
    setLoading(true);
    setError(null);
    const res = await apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500");
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
    apiGet<ApiListResult<SiteRow>>("/api/sites?take=500").then((res) => {
      if (res.ok) setSites(res.data.rows);
    });
    apiGet<ApiListResult<GuardRow>>("/api/guards?take=500").then((res) => {
      if (!res.ok) return;
      const counts: Record<string, number> = {};
      for (const g of res.data.rows) {
        if (!g.default_broker_id) continue;
        counts[g.default_broker_id] = (counts[g.default_broker_id] ?? 0) + 1;
      }
      setGuardCountByBroker(counts);
    });
    apiGet<ApiListResult<BrokerSiteAssignmentRow>>("/api/broker-site-assignments?take=500").then((res) => {
      if (res.ok) setAssignments(res.data.rows);
    });
  }, []);

  function siteLabel(id?: string | null): string {
    if (!id) return "（全盤預設）";
    return sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8);
  }

  function sitesLabel(brokerId: string): string {
    const ids = Array.from(
      new Set(
        assignments.filter((a) => a.broker_id === brokerId && a.month.slice(0, 7) === month).map((a) => a.site_id),
      ),
    );
    if (ids.length === 0) return "—";
    return ids.map((id) => sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8)).join("、");
  }

  async function loadFeeRates(brokerId: string) {
    setFeeRatesLoading(true);
    const res = await apiGet<ApiListResult<ReferralFeeRateRow>>(`/api/referral-fee-rates?broker_id=${brokerId}&take=200`);
    if (!res.ok) {
      setError(res.message);
      setFeeRatesLoading(false);
      return;
    }
    setFeeRates(res.data.rows);
    setHasFeePerShift(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "fee_per_shift" in r));
    setFeeRatesLoading(false);
  }

  function openFeeRatesFor(broker: BrokerRow) {
    setFeeRatesBroker(broker);
    setFeeRates([]);
    loadFeeRates(broker.id);
  }

  function openFeeRateCreate() {
    setEditingFeeRateId(null);
    setFeeRateForm(emptyFeeRateForm);
    setFeeRateFormError(null);
    setFeeRateDrawerOpen(true);
  }

  function openFeeRateEdit(row: ReferralFeeRateRow) {
    setEditingFeeRateId(row.id);
    setFeeRateForm({
      site_id: row.site_id ?? "",
      month: row.month.slice(0, 7),
      fee_per_shift: row.fee_per_shift == null ? "" : String(row.fee_per_shift),
    });
    setFeeRateFormError(null);
    setFeeRateDrawerOpen(true);
  }

  async function onFeeRateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!feeRatesBroker) return;
    setFeeRateFormError(null);
    setFeeRateSaving(true);
    const res = editingFeeRateId
      ? await apiPatch(`/api/referral-fee-rates/${editingFeeRateId}`, { fee_per_shift: Number(feeRateForm.fee_per_shift) })
      : await apiPost("/api/referral-fee-rates", {
          broker_id: feeRatesBroker.id,
          site_id: feeRateForm.site_id || undefined,
          month: feeRateForm.month,
          fee_per_shift: Number(feeRateForm.fee_per_shift),
        });
    setFeeRateSaving(false);
    if (!res.ok) {
      setFeeRateFormError(res.message);
      return;
    }
    setFeeRateDrawerOpen(false);
    setNotice(editingFeeRateId ? "已更新費率" : "已新增費率");
    await loadFeeRates(feeRatesBroker.id);
  }

  async function onFeeRateVoid(id: string, reason: string) {
    if (!feeRatesBroker) return;
    setError(null);
    const res = await apiPost(`/api/referral-fee-rates/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已作廢費率");
    await loadFeeRates(feeRatesBroker.id);
  }

  async function onFeeRateUnvoid(id: string) {
    if (!feeRatesBroker) return;
    setError(null);
    const res = await apiPost(`/api/referral-fee-rates/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已解除作廢費率");
    await loadFeeRates(feeRatesBroker.id);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: BrokerRow) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      name: row.name,
      kind: row.kind,
      settlement_type: row.settlement_type,
      bank_info: row.bank_info ? JSON.stringify(row.bank_info, null, 2) : "",
      requires_approval: row.requires_approval,
      aliases: (row.aliases ?? []).join(", "),
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    let bankInfo: unknown = undefined;
    if (form.bank_info.trim()) {
      try {
        bankInfo = JSON.parse(form.bank_info);
      } catch {
        setFormError("bank_info 唔係合法嘅 JSON");
        return;
      }
    }
    setSaving(true);
    const aliases = form.aliases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {
      name: form.name,
      settlement_type: form.settlement_type,
      bank_info: bankInfo,
      requires_approval: form.requires_approval,
      aliases,
    };
    const res = editingId
      ? await apiPatch(`/api/brokers/${editingId}`, body)
      : await apiPost("/api/brokers", { ...body, code: form.code, kind: form.kind });
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
    const res = await apiPost(`/api/brokers/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已停用");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/brokers/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已恢復");
    await load();
  }

  // S2：加返「需要審批」欄（README 冇逐個列，但 base 有，丟咗會少
  // 資料）——7 欄變 8 欄。
  const colCount = 8;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="主檔"
        title="雞頭"
        subtitle="每行「介紹費率」開返嗰個雞頭嘅逐盤逐月費率子表；「掛邊啲盤」按下面月份 FilterChip 嘅月睇。"
        actions={
          <>
            <FilterChip label="月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <Button variant="primary" onClick={openCreate}>
              新增雞頭
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!loading && rows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title="暫時冇雞頭" description="撳右上「新增雞頭」開始建立雞頭資料。" cta={<Button variant="primary" onClick={openCreate}>新增雞頭</Button>} />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>代號</th>
                  <th className={tableCls.th}>名稱</th>
                  <th className={tableCls.th}>種類</th>
                  <th className={tableCls.thNum}>人數</th>
                  <th className={tableCls.th}>掛邊啲盤</th>
                  <th className={tableCls.th}>需要審批</th>
                  <th className={tableCls.th}>狀態</th>
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
                {rows.map((r) => (
                  <tr key={r.id} className={tableCls.rowHover}>
                    <td className={`${tableCls.td} font-semibold`} style={{ color: brokerColor(r.code).fg }}>
                      {r.code}
                    </td>
                    <td className={`${tableCls.td} font-medium`}>{r.name}</td>
                    <td className={tableCls.td}>{kindPill(r.kind)}</td>
                    <td className={tableCls.tdNum}>{guardCountByBroker[r.id] ?? 0}</td>
                    <td className={tableCls.tdMuted}>{sitesLabel(r.id)}</td>
                    <td className={tableCls.td}>
                      {r.requires_approval ? <Pill variant="warning">需要</Pill> : <Pill variant="neutral">唔使</Pill>}
                    </td>
                    <td className={tableCls.td}>{r.status === "active" ? <Pill variant="success">正常</Pill> : <Pill variant="neutral">已停用</Pill>}</td>
                    <td className={tableCls.td}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                          編輯
                        </button>
                        <button
                          type="button"
                          onClick={() => openFeeRatesFor(r)}
                          className={`rounded-[5px] border px-2.5 py-[3px] text-xs hover:bg-zk-header ${feeRatesBroker?.id === r.id ? "border-[#0f172a] bg-[#0f172a] text-white hover:bg-[#1e293b]" : "border-zk-border text-[#334155]"}`}
                        >
                          介紹費率
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
                          <ConfirmVoidButton label="停用" confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border border-zk-border bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-medium text-zk-text">
                    {r.name} <span className="text-zk-faint">（{r.code}）</span>
                  </span>
                  <span className="text-[13px] tabular-nums text-zk-text">{guardCountByBroker[r.id] ?? 0} 人</span>
                </div>
                <div className="mt-1 text-[11.5px] text-zk-muted">{sitesLabel(r.id)}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {kindPill(r.kind)}
                  {r.requires_approval ? <Pill variant="warning">需要審批</Pill> : <Pill variant="neutral">唔使審批</Pill>}
                  {r.status === "active" ? <Pill variant="success">正常</Pill> : <Pill variant="neutral">已停用</Pill>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                    編輯
                  </button>
                  <button type="button" onClick={() => openFeeRatesFor(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                    介紹費率
                  </button>
                  {r.status === "inactive" ? (
                    <button type="button" onClick={() => onUnvoid(r.id)} className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700">
                      恢復
                    </button>
                  ) : (
                    <ConfirmVoidButton label="停用" confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {feeRatesBroker && (
        <div className="space-y-2 rounded-lg border border-zk-border bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13.5px] font-semibold text-zk-text">{feeRatesBroker.name}——介紹費率</h2>
              <p className="text-xs text-zk-muted">site 留空＝呢個雞頭全盤預設費率；有 site 嘅行覆蓋預設。</p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" onClick={openFeeRateCreate}>
                新增費率
              </Button>
              <Button variant="secondary" onClick={() => setFeeRatesBroker(null)}>
                收起
              </Button>
            </div>
          </div>

          <div className={tableCls.wrap}>
            <table className={tableCls.table}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>月份</th>
                  <th className={tableCls.thNum}>介紹費（每更）</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {feeRatesLoading && (
                  <tr>
                    <td className={tableCls.tdMuted} colSpan={5}>
                      載入緊…
                    </td>
                  </tr>
                )}
                {!feeRatesLoading && feeRates.length === 0 && (
                  <tr>
                    <td className={tableCls.tdMuted} colSpan={5}>
                      暫時冇費率行
                    </td>
                  </tr>
                )}
                {feeRates.map((r) => (
                  <tr key={r.id} className={`${tableCls.rowHover} ${r.voided_at ? "opacity-45" : ""}`}>
                    <td className={tableCls.td}>{siteLabel(r.site_id)}</td>
                    <td className={tableCls.td}>{r.month.slice(0, 7)}</td>
                    <td className={tableCls.tdNum}>{hasFeePerShift ? fmtMoney(r.fee_per_shift) : "—"}</td>
                    <td className={tableCls.td}>{r.voided_at ? <Pill variant="neutral">已作廢</Pill> : <Pill variant="success">有效</Pill>}</td>
                    <td className={tableCls.td}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!r.voided_at && (
                          <button type="button" onClick={() => openFeeRateEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                            編輯
                          </button>
                        )}
                        {r.voided_at ? (
                          <button
                            type="button"
                            onClick={() => onFeeRateUnvoid(r.id)}
                            className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700 hover:bg-green-50"
                          >
                            解除作廢
                          </button>
                        ) : (
                          <ConfirmVoidButton onConfirm={(reason) => onFeeRateVoid(r.id, reason)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Drawer open={drawerOpen} title={editingId ? "編輯雞頭" : "新增雞頭"} onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="代號（code）">
            <input className={inputCls} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} disabled={!!editingId} required />
          </Field>
          <Field label="名稱">
            <input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          </Field>
          <Field label="類型（kind）">
            <select className={selectCls} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} disabled={!!editingId}>
              {BROKER_KINDS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="結算方式（settlement_type）">
            <select
              className={selectCls}
              value={form.settlement_type}
              onChange={(e) => setForm((f) => ({ ...f, settlement_type: e.target.value }))}
            >
              {SETTLEMENT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="銀行資料（bank_info，JSON）" hint='例如：{"bank_name":"...","account_no":"..."}'>
            <textarea
              className={`${inputCls} h-24 font-mono text-xs`}
              value={form.bank_info}
              onChange={(e) => setForm((f) => ({ ...f, bank_info: e.target.value }))}
            />
          </Field>
          <Field label="更別（逗號分隔）">
            <input className={inputCls} value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.requires_approval}
              onChange={(e) => setForm((f) => ({ ...f, requires_approval: e.target.checked }))}
            />
            requires_approval（排更要主管審批先確認）
          </label>
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

      <Drawer
        open={feeRateDrawerOpen}
        title={editingFeeRateId ? `編輯費率（${feeRatesBroker?.name ?? ""}）` : `新增費率（${feeRatesBroker?.name ?? ""}）`}
        onClose={() => setFeeRateDrawerOpen(false)}
      >
        <form onSubmit={onFeeRateSubmit} className="space-y-3">
          <Banner kind="error" message={feeRateFormError} />
          <Field label="盤" hint="留空＝呢個雞頭全盤預設費率">
            <select
              className={selectCls}
              value={feeRateForm.site_id}
              onChange={(e) => setFeeRateForm((f) => ({ ...f, site_id: e.target.value }))}
              disabled={!!editingFeeRateId}
            >
              <option value="">（全盤預設）</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="月份">
            <input
              type="month"
              className={inputCls}
              value={feeRateForm.month}
              onChange={(e) => setFeeRateForm((f) => ({ ...f, month: e.target.value }))}
              disabled={!!editingFeeRateId}
              required
            />
          </Field>
          <Field label="介紹費（每更，fee_per_shift）">
            <input
              type="number"
              step="0.01"
              className={inputCls}
              value={feeRateForm.fee_per_shift}
              onChange={(e) => setFeeRateForm((f) => ({ ...f, fee_per_shift: e.target.value }))}
              required
            />
          </Field>
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={feeRateSaving} className={btnPrimary}>
              {feeRateSaving ? "儲存緊…" : "儲存"}
            </button>
            <button type="button" onClick={() => setFeeRateDrawerOpen(false)} className={btnSecondary}>
              取消
            </button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
