"use client";
// P2-A：盤管理頁（README §07）——換皮，邏輯／API 呼叫全部保留。
import { useEffect, useState } from "react";
import { FOCUS_CLS, useFocusParam, useScrollToFocus } from "@/components/reconcile/focus";
import { apiGet, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls, btnPrimary, btnSecondary } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmt, fmtMoney } from "@/lib/ui/format";
import { BILLING_MODELS } from "@/lib/ui/billing-model";

const PRORATA_BASIS = ["div_31", "div_month_days"] as const;
const BILLING_GROUPS = ["per_shift", "monthly_ic"] as const;

interface SiteRow {
  id: string;
  canonical_name: string;
  aliases: string[];
  client_name: string;
  client_group?: string | null;
  billing_model: string;
  monthly_fee?: string | number | null;
  monthly_posts?: number | null;
  prorata_basis?: string | null;
  in_scope: boolean;
  outside_monthly_close: boolean;
  // WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類盤嘅
  // 保安員由客戶直接出糧，我哋淨係收每月服務費——唔逐更計客價／工資。
  guards_paid_by_client: boolean;
  // WP-UPLOAD-AUTOFIX（老闆 2026-09-25 要求）：更表檔名鍵——上載時檔名
  // stem 含任一鍵（唔分大小寫）就直接用呢個盤，優先過檔內盤名對照。
  roster_file_keys?: string[];
  status: string;
}

interface ShiftTypeRow {
  id: string;
  site_id: string;
  code: string;
  label?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  hours?: string | number | null;
  headcount_required?: number | null;
  billing_group?: string | null;
  voided_at?: string | null;
}

const emptySiteForm = {
  canonical_name: "",
  aliases: "",
  client_name: "",
  client_group: "",
  billing_model: BILLING_MODELS[0] as string,
  monthly_fee: "",
  monthly_posts: "",
  prorata_basis: "",
  in_scope: true,
  outside_monthly_close: false,
  guards_paid_by_client: false,
  roster_file_keys: "",
};

function billingModelPill(model: string) {
  if (model === "monthly_fixed") return <Pill variant="monthly">月費</Pill>;
  if (model === "per_shift") return <Pill variant="neutral">逐更</Pill>;
  return <Pill variant="neutral">{model}</Pill>;
}

export default function SitesPage() {
  const [rows, setRows] = useState<SiteRow[]>([]);
  const [shiftTypesBySite, setShiftTypesBySite] = useState<Record<string, ShiftTypeRow[]>>({});
  // S1（Opus 驗收）：「更別」欄未讀到之前顯示「載入緊…」，唔好當佢真係
  // 冇更別（「—」）——落面 load() 一次過攞晒 shift-types 先會清呢個 flag。
  const [shiftTypesLoading, setShiftTypesLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasMoneyField, setHasMoneyField] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptySiteForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [shiftTypesFor, setShiftTypesFor] = useState<SiteRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const res = await apiGet<ApiListResult<SiteRow>>("/api/sites?take=500");
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setHasMoneyField(res.data.rows.length === 0 ? true : res.data.rows.some((r) => "monthly_fee" in r));
    setLoading(false);

    // S1（Opus 驗收修復）：README §07「更別」欄（「D · N · IC」）舊版逐盤
    // 一次 GET /api/shift-types?site_id=（64 個盤＝64 條 request，N+1）。
    // 改為一次過 GET /api/shift-types?take=500，前端 group by site_id。
    setShiftTypesLoading(true);
    const stRes = await apiGet<ApiListResult<ShiftTypeRow>>("/api/shift-types?take=500");
    if (stRes.ok) {
      const map: Record<string, ShiftTypeRow[]> = {};
      for (const st of stRes.data.rows) {
        if (st.voided_at) continue;
        (map[st.site_id] ??= []).push(st);
      }
      setShiftTypesBySite(map);
    }
    setShiftTypesLoading(false);
  }

  useEffect(() => {
    load();
  }, []);
  // WP-RECONCILE-UI（§33.3 D）：`/sites?focus=<siteId>` 高亮＋捲到該盤（純 UI）。
  const focusSite = useFocusParam();
  useScrollToFocus(focusSite, !loading && rows.length > 0);

  function openCreate() {
    setEditingId(null);
    setForm(emptySiteForm);
    setFormError(null);
    setDrawerOpen(true);
  }

  function openEdit(row: SiteRow) {
    setEditingId(row.id);
    setForm({
      canonical_name: row.canonical_name,
      aliases: (row.aliases ?? []).join(", "),
      client_name: row.client_name,
      client_group: row.client_group ?? "",
      billing_model: row.billing_model,
      monthly_fee: row.monthly_fee !== undefined && row.monthly_fee !== null ? String(row.monthly_fee) : "",
      monthly_posts: row.monthly_posts !== undefined && row.monthly_posts !== null ? String(row.monthly_posts) : "",
      prorata_basis: row.prorata_basis ?? "",
      in_scope: row.in_scope,
      outside_monthly_close: row.outside_monthly_close ?? false,
      guards_paid_by_client: row.guards_paid_by_client ?? false,
      roster_file_keys: (row.roster_file_keys ?? []).join(", "),
    });
    setFormError(null);
    setDrawerOpen(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const aliases = form.aliases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const rosterFileKeys = form.roster_file_keys
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {
      client_name: form.client_name,
      client_group: form.client_group || undefined,
      billing_model: form.billing_model,
      monthly_posts: form.monthly_posts ? Number(form.monthly_posts) : undefined,
      prorata_basis: form.prorata_basis || undefined,
      in_scope: form.in_scope,
      outside_monthly_close: form.outside_monthly_close,
      guards_paid_by_client: form.guards_paid_by_client,
      aliases,
      roster_file_keys: rosterFileKeys,
    };
    if (hasMoneyField && form.monthly_fee !== "") body.monthly_fee = Number(form.monthly_fee);

    const res = editingId
      ? await apiPatch(`/api/sites/${editingId}`, body)
      : await apiPost("/api/sites", { ...body, canonical_name: form.canonical_name });
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
    const res = await apiPost(`/api/sites/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已結束");
    await load();
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/sites/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已恢復");
    await load();
  }

  // 其他（Opus 驗收）：頭列實際係 盤名/客戶/結算模式/(月費)/更別/狀態/
  // 操作——hasMoneyField 就 7 欄，冇就 6 欄（原本寫死 6/5，靠落面
  // colSpan「+1」補返，而家 colCount 本身改啱，colSpan 唔使再 +1）。
  const colCount = hasMoneyField ? 7 : 6;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="主檔"
        title="盤"
        subtitle="盤管理——每個盤可以有多個更別（子表）。"
        actions={
          <Button variant="primary" onClick={openCreate}>
            新增盤
          </Button>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!loading && rows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title="暫時冇任何盤" description="撳右上「新增盤」開始建立客戶／盤資料。" cta={<Button variant="primary" onClick={openCreate}>新增盤</Button>} />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤名</th>
                  <th className={tableCls.th}>客戶</th>
                  <th className={tableCls.th}>結算模式</th>
                  {hasMoneyField && <th className={tableCls.thNum}>月費</th>}
                  <th className={tableCls.th}>更別</th>
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
                  <tr key={r.id} className={`${tableCls.rowHover} ${focusSite === r.id ? FOCUS_CLS : ""}`} data-focus-key={r.id} data-focused={focusSite === r.id ? "1" : undefined}>
                    <td className={`${tableCls.td} font-medium`}>{r.canonical_name}</td>
                    <td className={tableCls.td}>{r.client_name}</td>
                    <td className={tableCls.td}>{billingModelPill(r.billing_model)}</td>
                    {hasMoneyField && (
                      <td className={tableCls.tdNum}>{r.billing_model === "per_shift" ? "—" : fmtMoney(r.monthly_fee)}</td>
                    )}
                    <td className={tableCls.tdMuted}>
                      {shiftTypesLoading
                        ? "載入緊…"
                        : (shiftTypesBySite[r.id] ?? []).length > 0
                          ? shiftTypesBySite[r.id]!.map((s) => s.code).join(" · ")
                          : "—"}
                    </td>
                    <td className={tableCls.td}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.status === "active" ? <Pill variant="success">進行中</Pill> : <Pill variant="neutral">{r.status}</Pill>}
                        {r.guards_paid_by_client && <Pill variant="neutral">客戶直接出糧</Pill>}
                      </div>
                    </td>
                    <td className={tableCls.td}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                          編輯
                        </button>
                        <button
                          type="button"
                          onClick={() => setShiftTypesFor(r)}
                          className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header"
                        >
                          更別
                        </button>
                        {r.status === "ended" ? (
                          <button
                            type="button"
                            onClick={() => onUnvoid(r.id)}
                            className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700 hover:bg-green-50"
                          >
                            恢復
                          </button>
                        ) : (
                          <ConfirmVoidButton label="結束" confirmLabel="確認結束" onConfirm={(reason) => onVoid(r.id, reason)} />
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
              <div key={r.id} className={`rounded-lg border bg-white p-3 ${focusSite === r.id ? "border-zk-primary bg-yellow-50 ring-2 ring-zk-primary" : "border-zk-border"}`} data-focus-key={r.id} data-focused={focusSite === r.id ? "1" : undefined}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-medium text-zk-text">{r.canonical_name}</span>
                  {hasMoneyField && (
                    <span className="text-[13px] tabular-nums text-zk-text">{r.billing_model === "per_shift" ? "—" : fmtMoney(r.monthly_fee)}</span>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-zk-muted">{r.client_name}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {billingModelPill(r.billing_model)}
                  {r.status === "active" ? <Pill variant="success">進行中</Pill> : <Pill variant="neutral">{r.status}</Pill>}
                  {r.guards_paid_by_client && <Pill variant="neutral">客戶直接出糧</Pill>}
                  <span className="text-[11.5px] text-zk-muted">
                    {shiftTypesLoading ? "載入緊…" : (shiftTypesBySite[r.id] ?? []).map((s) => s.code).join(" · ") || "—"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => openEdit(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                    編輯
                  </button>
                  <button type="button" onClick={() => setShiftTypesFor(r)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                    更別
                  </button>
                  {r.status === "ended" ? (
                    <button type="button" onClick={() => onUnvoid(r.id)} className="rounded-[5px] border border-green-300 px-2.5 py-[3px] text-xs text-green-700">
                      恢復
                    </button>
                  ) : (
                    <ConfirmVoidButton label="結束" confirmLabel="確認結束" onConfirm={(reason) => onVoid(r.id, reason)} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Drawer open={drawerOpen} title={editingId ? "編輯盤" : "新增盤"} onClose={() => setDrawerOpen(false)}>
        <form onSubmit={onSubmit} className="space-y-3">
          <Banner kind="error" message={formError} />
          <Field label="盤名（canonical_name）">
            <input
              className={inputCls}
              value={form.canonical_name}
              onChange={(e) => setForm((f) => ({ ...f, canonical_name: e.target.value }))}
              disabled={!!editingId}
              required
            />
          </Field>
          <Field label="更別（逗號分隔）" hint="例如：日更, 夜更">
            <input className={inputCls} value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} />
          </Field>
          <Field label="更表檔名鍵（逗號分隔）" hint="會計上載更表時，檔名含呢啲字（唔分大小寫；數字／英文要成個字，「615」唔會中「9615」）就自動配去呢個盤，優先過檔內盤名。例如：CTB 6907">
            <input
              className={inputCls}
              value={form.roster_file_keys}
              onChange={(e) => setForm((f) => ({ ...f, roster_file_keys: e.target.value }))}
            />
          </Field>
          <Field label="客戶名稱">
            <input className={inputCls} value={form.client_name} onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))} required />
          </Field>
          <Field label="客戶分組">
            <input className={inputCls} value={form.client_group} onChange={(e) => setForm((f) => ({ ...f, client_group: e.target.value }))} />
          </Field>
          <Field label="結算模式（billing_model）">
            <select className={selectCls} value={form.billing_model} onChange={(e) => setForm((f) => ({ ...f, billing_model: e.target.value }))}>
              {BILLING_MODELS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {hasMoneyField ? (
            <Field label="月費（monthly_fee）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.monthly_fee}
                onChange={(e) => setForm((f) => ({ ...f, monthly_fee: e.target.value }))}
              />
            </Field>
          ) : (
            <Field label="月費（monthly_fee）">
              <div className="text-sm text-gray-400">—（冇「收客價」權限）</div>
            </Field>
          )}
          <Field label="月費崗數（monthly_posts）">
            <input
              type="number"
              className={inputCls}
              value={form.monthly_posts}
              onChange={(e) => setForm((f) => ({ ...f, monthly_posts: e.target.value }))}
            />
          </Field>
          <Field label="Pro-rata 基準">
            <select className={selectCls} value={form.prorata_basis} onChange={(e) => setForm((f) => ({ ...f, prorata_basis: e.target.value }))}>
              <option value="">（不適用）</option>
              {PRORATA_BASIS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.in_scope} onChange={(e) => setForm((f) => ({ ...f, in_scope: e.target.checked }))} />
            in_scope（計入報表範圍）
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.outside_monthly_close} onChange={(e) => setForm((f) => ({ ...f, outside_monthly_close: e.target.checked }))} />
            月結以外（收入唔入月結總表主表，另列「月結以外」）
          </label>
          {/* WP-MISC（老闆 2026-09-20 拍板）：LINK 呢類盤——保安員由客戶
              直接出糧，我哋淨係收每月服務費，唔逐更計客價／工資。 */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.guards_paid_by_client}
              onChange={(e) => setForm((f) => ({ ...f, guards_paid_by_client: e.target.checked }))}
            />
            客戶直接出糧（保安員由客戶直接出糧，我哋淨係收每月服務費，呢個盤嘅更唔計工資／客價）
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

      <ShiftTypesDrawer site={shiftTypesFor} onClose={() => setShiftTypesFor(null)} onChanged={load} />
    </div>
  );
}

const emptyShiftTypeForm = {
  code: "",
  label: "",
  start_time: "",
  end_time: "",
  hours: "",
  headcount_required: "",
  billing_group: "",
};

function ShiftTypesDrawer({ site, onClose, onChanged }: { site: SiteRow | null; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<ShiftTypeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyShiftTypeForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load(siteId: string) {
    setLoading(true);
    setError(null);
    const res = await apiGet<ApiListResult<ShiftTypeRow>>(`/api/shift-types?site_id=${siteId}&take=500`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setLoading(false);
  }

  useEffect(() => {
    if (site) {
      load(site.id);
      setShowForm(false);
      setEditingId(null);
      setForm(emptyShiftTypeForm);
    }
  }, [site]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyShiftTypeForm);
    setShowForm(true);
  }

  function openEdit(row: ShiftTypeRow) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      label: row.label ?? "",
      start_time: row.start_time ?? "",
      end_time: row.end_time ?? "",
      hours: row.hours !== undefined && row.hours !== null ? String(row.hours) : "",
      headcount_required: row.headcount_required !== undefined && row.headcount_required !== null ? String(row.headcount_required) : "",
      billing_group: row.billing_group ?? "",
    });
    setShowForm(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!site) return;
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = {
      code: form.code,
      label: form.label || undefined,
      start_time: form.start_time || undefined,
      end_time: form.end_time || undefined,
      hours: form.hours ? Number(form.hours) : undefined,
      headcount_required: form.headcount_required ? Number(form.headcount_required) : undefined,
      billing_group: form.billing_group || undefined,
    };
    const res = editingId
      ? await apiPatch(`/api/shift-types/${editingId}`, body)
      : await apiPost("/api/shift-types", { ...body, site_id: site.id });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setShowForm(false);
    await load(site.id);
    onChanged();
  }

  async function onVoid(id: string, reason: string) {
    if (!site) return;
    setError(null);
    const res = await apiPost(`/api/shift-types/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await load(site.id);
    onChanged();
  }

  async function onUnvoid(id: string) {
    if (!site) return;
    setError(null);
    const res = await apiPost(`/api/shift-types/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await load(site.id);
    onChanged();
  }

  return (
    <Drawer open={!!site} title={site ? `更別——${site.canonical_name}` : "更別"} onClose={onClose} widthClassName="w-[520px]">
      <div className="space-y-3">
        <Banner kind="error" message={error} />
        <div className="flex justify-end">
          <button type="button" onClick={openCreate} className={btnPrimary}>
            新增更別
          </button>
        </div>

        {showForm && (
          <form onSubmit={onSubmit} className="space-y-2 rounded border border-gray-200 p-3">
            <Field label="代號（code）">
              <input className={inputCls} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} required />
            </Field>
            <Field label="名稱（label）">
              <input className={inputCls} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="開始時間">
                <input
                  className={inputCls}
                  placeholder="HH:mm"
                  value={form.start_time}
                  onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))}
                />
              </Field>
              <Field label="結束時間">
                <input
                  className={inputCls}
                  placeholder="HH:mm"
                  value={form.end_time}
                  onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="時數">
                <input type="number" step="0.5" className={inputCls} value={form.hours} onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))} />
              </Field>
              <Field label="需求人數">
                <input
                  type="number"
                  className={inputCls}
                  value={form.headcount_required}
                  onChange={(e) => setForm((f) => ({ ...f, headcount_required: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="計費分組（billing_group）">
              <select className={selectCls} value={form.billing_group} onChange={(e) => setForm((f) => ({ ...f, billing_group: e.target.value }))}>
                <option value="">（不適用）</option>
                {BILLING_GROUPS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={saving} className={btnPrimary}>
                {saving ? "儲存緊…" : "儲存"}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className={btnSecondary}>
                取消
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-2 py-1.5">代號</th>
                <th className="px-2 py-1.5">名稱</th>
                <th className="px-2 py-1.5">時段</th>
                <th className="px-2 py-1.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td className="px-2 py-3 text-gray-400" colSpan={4}>
                    載入緊…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-gray-400" colSpan={4}>
                    暫時冇更別
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-2 py-1.5">{r.code}</td>
                  <td className="px-2 py-1.5">{fmt(r.label)}</td>
                  <td className="px-2 py-1.5">
                    {fmt(r.start_time)}–{fmt(r.end_time)}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <button type="button" onClick={() => openEdit(r)} className="rounded border border-gray-300 px-1.5 py-0.5 hover:bg-gray-50">
                        編輯
                      </button>
                      {r.voided_at ? (
                        <button
                          type="button"
                          onClick={() => onUnvoid(r.id)}
                          className="rounded border border-green-300 px-1.5 py-0.5 text-green-700 hover:bg-green-50"
                        >
                          解除作廢
                        </button>
                      ) : (
                        <ConfirmVoidButton onConfirm={(reason) => onVoid(r.id, reason)} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Drawer>
  );
}
