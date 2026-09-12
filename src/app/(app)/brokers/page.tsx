"use client";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { fmtMoney } from "@/lib/ui/format";

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

// P1-WP3（E）：referral_fee_rates（雞頭介紹費率）——每個雞頭一份子表，
// 逐盤逐月可變。「雞頭」module——出廠淨係老闆有 create/update/void
// grant（主管/會計出廠 ○，可以後續喺角色權限管理開）；雞頭自己讀
// GET 見自己，寫入一律硬性 deny，呢個管理頁本身雞頭角色都入唔到
// （見 src/app/(app)/layout.tsx 嘅選單/路由權限）。
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

const emptyFeeRateForm = { site_id: "", month: "", fee_per_shift: "" };

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

  // P1-WP3（E）：介紹費率子表——揀咗邊個雞頭先出嚟。
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
  }, []);

  function siteLabel(id?: string | null): string {
    if (!id) return "（全盤預設）";
    return sites.find((s) => s.id === id)?.canonical_name ?? id.slice(0, 8);
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
    // 冇「出街價:view」嘅角色（例如關咗呢格權限嘅會計）response 會冇
    // fee_per_shift 呢粒欄——同 rate-cards 頁 hasClientRate/hasPayoutRate
    // 一致做法，成欄顯示「—」，唔靠估。
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">雞頭管理</h1>
          <p className="text-sm text-gray-500">每行「介紹費率」開返嗰個雞頭嘅逐盤逐月費率子表。</p>
        </div>
        <button type="button" onClick={openCreate} className={btnPrimary}>
          新增
        </button>
      </div>

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">代號</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2">類型</th>
              <th className="px-3 py-2">需要審批</th>
              <th className="px-3 py-2">狀態</th>
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
                  暫時冇資料
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-3 py-2">{r.code}</td>
                <td className="px-3 py-2 font-medium text-gray-900">{r.name}</td>
                <td className="px-3 py-2">{r.kind}</td>
                <td className="px-3 py-2">{r.requires_approval ? "是" : "否"}</td>
                <td className="px-3 py-2">{r.status}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => openEdit(r)} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                      編輯
                    </button>
                    <button
                      type="button"
                      onClick={() => openFeeRatesFor(r)}
                      className={`rounded border px-2 py-1 text-xs hover:bg-gray-50 ${feeRatesBroker?.id === r.id ? "border-gray-900 bg-gray-900 text-white hover:bg-gray-800" : "border-gray-300"}`}
                    >
                      介紹費率
                    </button>
                    {r.status === "inactive" ? (
                      <button
                        type="button"
                        onClick={() => onUnvoid(r.id)}
                        className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
                      >
                        恢復
                      </button>
                    ) : (
                      <ConfirmVoidButton confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {feeRatesBroker && (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">{feeRatesBroker.name}——介紹費率</h2>
              <p className="text-xs text-gray-500">site 留空＝呢個雞頭全盤預設費率；有 site 嘅行覆蓋預設。</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={openFeeRateCreate} className={btnPrimary}>
                新增費率
              </button>
              <button type="button" onClick={() => setFeeRatesBroker(null)} className={btnSecondary}>
                收起
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-gray-100">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">盤</th>
                  <th className="px-3 py-2">月份</th>
                  <th className="px-3 py-2">介紹費（每更）</th>
                  <th className="px-3 py-2">狀態</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {feeRatesLoading && (
                  <tr>
                    <td className="px-3 py-4 text-gray-400" colSpan={5}>
                      載入緊…
                    </td>
                  </tr>
                )}
                {!feeRatesLoading && feeRates.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-gray-400" colSpan={5}>
                      暫時冇費率行
                    </td>
                  </tr>
                )}
                {feeRates.map((r) => (
                  <tr key={r.id} className={`border-t border-gray-100 ${r.voided_at ? "opacity-50" : ""}`}>
                    <td className="px-3 py-2">{siteLabel(r.site_id)}</td>
                    <td className="px-3 py-2">{r.month.slice(0, 7)}</td>
                    <td className="px-3 py-2">{hasFeePerShift ? fmtMoney(r.fee_per_shift) : "—"}</td>
                    <td className="px-3 py-2">{r.voided_at ? "已作廢" : "有效"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!r.voided_at && (
                          <button type="button" onClick={() => openFeeRateEdit(r)} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                            編輯
                          </button>
                        )}
                        {r.voided_at ? (
                          <button
                            type="button"
                            onClick={() => onFeeRateUnvoid(r.id)}
                            className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
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
