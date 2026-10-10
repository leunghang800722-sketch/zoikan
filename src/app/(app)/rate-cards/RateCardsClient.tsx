"use client";
// P2-A：價目頁（README §10）——換皮，邏輯／API 呼叫、權限遮蔽
// （hasClientRate/hasPayoutRate 判斷唔變）全部保留。
//
// A3（Opus 整合驗收）：呢個 client component 由 `./page.tsx`（server
// component，攞 session）傳 `isBroker` 落嚟，跟 `my-receivable` 果頁
// 同一個 pattern——雞頭 session 頁首 kicker 要顯示「我的」（跟
// `src/lib/rbac/nav.ts` 導航分組），唔可以再寫死「主檔」。
import { DrawerFormFooter } from "@/components/ui/DrawerFormFooter";
import { useEffect, useState } from "react";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { Banner } from "@/components/ui/Banner";
import { Drawer } from "@/components/ui/Drawer";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState, TableLoadingRow } from "@/components/ui/DataTable";
import { fmtDate, fmtMoney } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import { BILLING_MODELS } from "@/lib/ui/billing-model";
import { kickerFor } from "@/lib/nav/schema";
import { MonthPicker } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useCrudPage } from "@/lib/ui/use-crud-page";

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
  status?: string;
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
  // 應修（Opus 第二輪驗收）：RateCardCreateSchema 而家 billing_model 必填
  // ——前端預設 per_shift（絕大多數卡都係逐更收費，減少用戶漏揀撞 400）。
  billing_model: "per_shift",
  effective_from: "",
  effective_to: "",
  note: "",
};

// WP-PHASE3（§20.4 Phase 3 item 3）：「複製上月卡到本月」預覽一行。
interface CopyLastMonthCandidate {
  site_id: string;
  site_name: string;
  shift_type_id: string;
  shift_type_code: string;
  broker_id: string | null;
  broker_label: string;
  client_rate: string | null;
  guard_wage: string | null;
}

export function RateCardsClient({
  isBroker,
  canReprice = false,
  canCopyLastMonth = false,
}: {
  isBroker: boolean;
  canReprice?: boolean;
  canCopyLastMonth?: boolean;
}) {
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
  // P3-5.3：rows／loading／error／notice／drawer／form／saving 改用共用 `useCrudPage`（同 brokers／sites／quotas／users 一致）。
  const {
    rows, setRows, loading, setLoading, error, setError, notice, setNotice,
    drawerOpen, setDrawerOpen, form, setForm, formError, saving,
    openCreate: openCreateDrawer, saveForm, runAction,
  } = useCrudPage<RateCardRow, typeof emptyForm>(emptyForm);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [siteFilter, setSiteFilter] = useState("");
  // A4：「生效月」FilterChip——月份輸入，純客戶端篩（唔加新 API
  // query param）；預設空字串＝全部，唔篩。
  const [effectiveMonthFilter, setEffectiveMonthFilter] = useState("");
  // P3-4：「去處理 ›」帶 `?month=` 入嚟就當初始生效月（mount 後讀，避免 hydration mismatch；仍然係本地 state，唔帶＝空＝全部）。
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) setEffectiveMonthFilter(m);
  }, []);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [shiftTypes, setShiftTypes] = useState<ShiftTypeRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [guards, setGuards] = useState<GuardRow[]>([]);
  const [hasClientRate, setHasClientRate] = useState(true);
  const [hasPayoutRate, setHasPayoutRate] = useState(true);

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

  // WP-PHASE3（§20.4 Phase 3 item 4）：「未定價 OT 清單」——複用現有
  // `GET /api/shift-records/unpriced`（同更表頁頂 banner 同一份口徑），
  // 淨係揀 `category=ot_unpriced` 呢一類，俾「建卡」快捷用。冇權
  // （403，例如關咗「更表:view」嘅自訂角色）就淨係唔顯示呢個分區，唔
  // 阻住主頁。
  const [otUnpricedGroups, setOtUnpricedGroups] = useState<
    Array<{ site_id: string; site_name: string; shift_type_code: string; broker_code: string | null; broker_display: string; count: number }>
  >([]);
  useEffect(() => {
    (async () => {
      const month = effectiveMonthFilter || new Date().toISOString().slice(0, 7);
      const qs = new URLSearchParams({ month, ...(siteFilter ? { site_id: siteFilter } : {}) });
      const res = await apiGet<{ groups: typeof otUnpricedGroups }>(`/api/shift-records/unpriced?${qs.toString()}`);
      setOtUnpricedGroups(res.ok ? res.data.groups.filter((g) => (g as unknown as { category: string }).category === "ot_unpriced") : []);
    })();
  }, [effectiveMonthFilter, siteFilter, notice]);

  /** OT 未定價一行「建卡」——喺已載入嘅 `shiftTypes` 度用 (site_id, code)
   * 揾返 shift_type_id（`unpriced` API 唔出 id，淨係 code——見
   * src/lib/pricing/unpriced.ts UnpricedGroup），揾唔到（更別已刪／未
   * 載入齊）就唔預填，用戶自己揀。 */
  function openCreateForOt(siteId: string, code: string, brokerCode: string | null) {
    const st = shiftTypes.find((s) => s.site_id === siteId && s.code === code);
    const b = brokerCode ? brokers.find((x) => x.code === brokerCode) : undefined;
    openCreateDrawer({ ...emptyForm, site_id: siteId, shift_type_id: st?.id ?? "", broker_id: b?.id ?? "" });
  }

  // WP-PHASE3（item 3）：「複製上月卡到本月」——dry-run 預覽→confirm。
  const [copyingLastMonth, setCopyingLastMonth] = useState(false);
  async function handleCopyLastMonth() {
    if (copyingLastMonth) return;
    const month = effectiveMonthFilter || new Date().toISOString().slice(0, 7);
    setCopyingLastMonth(true);
    setError(null);
    setNotice(null);
    const body = { month, dry_run: true, ...(siteFilter ? { site_id: siteFilter } : {}) };
    const preview = await apiPost<{ count: number; candidates: CopyLastMonthCandidate[] }>("/api/rate-cards/copy-last-month", body);
    if (!preview.ok) {
      setCopyingLastMonth(false);
      setError(preview.message);
      return;
    }
    if (preview.data.count === 0) {
      setCopyingLastMonth(false);
      setNotice(`複製上月卡預覽 ${month}：冇搵到可以複製嘅上月卡（可能上月卡已經覆蓋本月，或者本月已經有卡）。`);
      return;
    }
    const lines = preview.data.candidates
      .slice(0, 20)
      .map((c) => `${c.site_name} ${c.shift_type_code}（${c.broker_label}）收客 ${c.client_rate ?? "—"}／工資 ${c.guard_wage ?? "—"}`)
      .join("\n");
    const more = preview.data.count > 20 ? `\n…仲有 ${preview.data.count - 20} 張` : "";
    const proceed = await askConfirm({ message: `複製上月卡到本月 ${month}：搵到 ${preview.data.count} 張卡可以複製\n${lines}${more}\n\n確定要建立呢 ${preview.data.count} 張新卡？`, confirmLabel: "建立" });
    if (!proceed) {
      setCopyingLastMonth(false);
      return;
    }
    const res = await apiPost<{ created_count: number }>("/api/rate-cards/copy-last-month", { ...body, dry_run: false });
    setCopyingLastMonth(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(`複製上月卡完成：已建立 ${res.data.created_count} 張新卡（note「由上月複製」，覆核價錢有變要去改）。`);
    await load();
  }

  // WP-PRICE §M3（老闆 2026-09-16 拍板）：「重新計價」——用「生效月」
  // 篩選器揀嘅月份（冇揀就用返家陣個月）。改為 dry-run 預覽→confirm→
  // 先至真係 dry_run:false 寫入，同 payroll/roster 頁一樣嘅設計。
  const [repricing, setRepricing] = useState(false);
  async function handleReprice() {
    if (repricing) return;
    const month = effectiveMonthFilter || new Date().toISOString().slice(0, 7);
    const scopeLabel = siteFilter ? (sites.find((s) => s.id === siteFilter)?.canonical_name ?? "呢個盤") : "全部盤";
    setRepricing(true);
    setError(null);
    setNotice(null);
    const body = { month, dry_run: true, ...(siteFilter ? { site_id: siteFilter } : {}) };
    const preview = await apiPost<{ changed: number; unchanged: number; kept_unresolved: number; unpriced: number }>("/api/shift-records/reprice", body);
    if (!preview.ok) {
      setRepricing(false);
      setError(preview.message);
      return;
    }
    if (preview.data.changed === 0) {
      setRepricing(false);
      setNotice(`重新計價預覽：${month}（${scopeLabel}）冇任何更次嘅 snapshot 會變，${preview.data.unpriced} 更仍然未定價。冇嘢寫入。`);
      return;
    }
    const keptNote = preview.data.kept_unresolved > 0 ? `（其中 ${preview.data.kept_unresolved} 更搵唔到對應卡，保留原有 snapshot）` : "";
    const proceed = await askConfirm({
      message: `重新計價預覽 ${month}（${scopeLabel}）：${preview.data.changed} 更會改變，${preview.data.unchanged} 更不變${keptNote}，仲有 ${preview.data.unpriced} 更未定價。確定要寫入？`,
      confirmLabel: "寫入",
    });
    if (!proceed) {
      setRepricing(false);
      return;
    }
    const res = await apiPost<{ repriced: number; unpriced: number }>("/api/shift-records/reprice", { ...body, dry_run: false });
    setRepricing(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    // 必修 2（Opus 第二輪驗收）：寫入成功之後唔用 reprice 回覆嘅
    // `unpriced` 數直接落 notice——重新 fetch `/api/shift-records/
    // unpriced`（`buildUnpricedSummary()`，同 roster/payroll 頁一致嘅
    // 權威口徑）先至話俾用戶知。攞唔到就 fallback 用返 reprice 回覆嘅數
    // （additive，唔阻住主流程）。
    const qs = new URLSearchParams({ month, ...(siteFilter ? { site_id: siteFilter } : {}) });
    const unpricedRes = await apiGet<{ count: number }>(`/api/shift-records/unpriced?${qs.toString()}`);
    const unpricedCount = unpricedRes.ok ? unpricedRes.data.count : res.data.unpriced;
    setNotice(`重新計價完成：${res.data.repriced} 更已改寫，仲有 ${unpricedCount} 更未定價。`);
  }

  useEffect(() => {
    (async () => {
      // M2（Opus 驗收修復）：更別欄舊版淨係喺揀咗盤先 load 一個 site
      // 嘅 shift-types（原本掛喺 form.site_id 嘅 useEffect），令列表 255
      // 行全部搵唔到、一律顯示「通用」。改為入頁一次攞晒（take=500），
      // 前端按 id 對；雞頭欄同理，`/api/brokers` 帶 `include_inactive=1`
      // （API 已有呢個唯讀參數，additive），先可以分辨「通用」（broker_id
      // 為 null）同「指向咗一個已停用嘅雞頭」。
      const [siteRes, brokerRes, guardRes, shiftTypeRes] = await Promise.all([
        cachedGetAll<SiteRow>("/api/sites"),
        cachedGetAll<BrokerRow>("/api/brokers?include_inactive=1"),
        cachedGetAll<GuardRow>("/api/guards?fields=lite"),
        cachedGetAll<ShiftTypeRow>("/api/shift-types"),
      ]);
      if (siteRes.ok) setSites(siteRes.data.rows);
      if (brokerRes.ok) setBrokers(brokerRes.data.rows);
      if (guardRes.ok) setGuards(guardRes.data.rows);
      if (shiftTypeRes.ok) setShiftTypes(shiftTypeRes.data.rows);
    })();
  }, []);

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

  // M2（Opus 驗收修復）：`shift_type_id`/`broker_id` 為 null 先真係「通
  // 用」；非 null 但喺已載入嘅名單搵唔到（例如更別已被刪、雞頭理論上唔
  // 應該會刪）就顯示 id 首 8 位＋灰色，唔准當成「通用」誤導。
  function renderShiftTypeCell(shiftTypeId?: string | null) {
    if (!shiftTypeId) return <Pill variant="neutral">通用</Pill>;
    const st = shiftType(shiftTypeId);
    if (st) {
      return (
        <Pill variant="broker" color={shiftCodeStyle(st.code)}>
          {st.code}
        </Pill>
      );
    }
    return <span className="text-zk-faint">{shiftTypeId.slice(0, 8)}</span>;
  }

  function renderBrokerCell(brokerId?: string | null) {
    if (!brokerId) return <span>通用</span>;
    const b = broker(brokerId);
    if (b) {
      return (
        <Pill variant="broker" color={brokerColor(b.code)}>
          {b.name}
          {b.status === "inactive" ? "（已停用）" : ""}
        </Pill>
      );
    }
    return <span className="text-zk-faint">{brokerId.slice(0, 8)}</span>;
  }

  function openCreate() {
    openCreateDrawer({ ...emptyForm, site_id: siteFilter || "" });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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

    await saveForm(() => apiPost("/api/rate-cards", body), load);
  }

  async function onVoid(id: string, reason: string) {
    await runAction(() => apiPost(`/api/rate-cards/${id}/void`, { reason }), "已作廢", load);
  }

  async function onUnvoid(id: string) {
    await runAction(() => apiPost(`/api/rate-cards/${id}/unvoid`), "已解除作廢", load);
  }

  const colCount = 10;

  // A4：`effective_from ≤ 月末 且 (effective_to 為 null 或 ≥ 月初)`——同
  // 「呢張價目喺呢個月有生效」嘅業務定義一致（同 rate-cards 讀取邏輯,
  // 例如 src/lib/broker-isolation.ts／report 內部揀價嘅生效區間判斷,
  // 同一條件）。純客戶端篩已載入嗰頁 `rows`，唔加新 API query param。
  function inEffectiveMonth(r: RateCardRow): boolean {
    if (!effectiveMonthFilter) return true;
    const [y, m] = effectiveMonthFilter.split("-").map(Number);
    const monthStartUtc = Date.UTC(y!, m! - 1, 1);
    const monthEndUtc = Date.UTC(y!, m!, 0, 23, 59, 59, 999); // 月尾最後一刻
    const from = new Date(r.effective_from).getTime();
    const to = r.effective_to ? new Date(r.effective_to).getTime() : null;
    return from <= monthEndUtc && (to === null || to >= monthStartUtc);
  }
  const visibleRows = rows.filter(inEffectiveMonth);

  return (
    <div className="space-y-4">
      {confirmDialog}
      <PageHeader
        kicker={kickerFor("/rate-cards", isBroker)}
        title="價目"
        subtitle="每個盤每個更別每個雞頭嘅價；冇權睇嘅欄顯示「—」。"
        actions={
          <>
            <FilterChip label="盤">
              <select
                data-testid="rate-cards-site-filter"
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
            <MonthPicker label="生效月" value={effectiveMonthFilter} onChange={setEffectiveMonthFilter} testId="rate-cards-effective-month" ariaLabel="生效月" allowEmpty />
            {canReprice && (
              <Button variant="secondary" onClick={handleReprice} disabled={repricing}>
                {repricing ? "計價緊…" : `重新計價（${effectiveMonthFilter || "本月"}）`}
              </Button>
            )}
            {/* WP-PHASE3（§20.4 Phase 3 item 3）：「複製上月卡到本月」——
                代替 8 月教訓入面「新月份要人手逐張補卡」，唔靠一鍵結算
                自動沿用（見 src/lib/month-close/one-click.ts stepPrecheck()
                大註解——一鍵結算 step0 而家改做偵測＋建議，唔再自動寫
                卡）。 */}
            {canCopyLastMonth && (
              <Button variant="secondary" onClick={handleCopyLastMonth} disabled={copyingLastMonth}>
                {copyingLastMonth ? "複製緊…" : `複製上月卡到本月（${effectiveMonthFilter || "本月"}）`}
              </Button>
            )}
            <Button variant="primary" onClick={openCreate}>
              新增價目
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {/* WP-PHASE3（§20.4 Phase 3 item 4）：OT 卡管理——未定價 OT 清單，
          每項有「建卡」快捷（預填盤／更別／雞頭，開返「新增價目」抽屜）。
          WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）：OT 卡金額＝每小時價，
          系統寫入時已乘 OT 時數（淨係 2026-08-01 起嘅記錄；7 月 OT
          snapshot 由 seed 直接寫，唔受呢個決定影響）。建卡之後 OT 記錄
          由「重新對數全月」／一鍵結算開頭嘅自動補價補返（reprice.ts）。 */}
      {otUnpricedGroups.length > 0 && (
        <div className="rounded-[7px] border border-zk-warning-border bg-zk-warning-bg p-3">
          <div className="text-zk-base font-medium text-zk-warning-dark">未定價 OT（{otUnpricedGroups.reduce((a, g) => a + g.count, 0)} 條記錄）——建卡後重跑「一鍵結算」或「重新對數全月」先會補返價</div>
          <ul className="mt-1.5 space-y-1">
            {otUnpricedGroups.map((g, i) => (
              <li key={`${g.site_id}-${g.shift_type_code}-${g.broker_code ?? "none"}-${i}`} className="flex items-center justify-between gap-2 text-zk-sm text-zk-warning-dark">
                <span className="min-w-0 break-words">
                  {g.site_name} · {g.shift_type_code} · {g.broker_display}（{g.count} 條）
                </span>
                <button
                  type="button"
                  onClick={() => openCreateForOt(g.site_id, g.shift_type_code, g.broker_code)}
                  className="shrink-0 rounded border border-zk-warning-border bg-white px-2 py-0.5 text-zk-sm text-zk-warning-dark hover:bg-zk-warning-tint"
                >
                  建卡
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && visibleRows.length === 0 ? (
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
                  <TableLoadingRow colSpan={colCount} />
                )}
                {visibleRows.map((r) => {
                  return (
                    <tr key={r.id} className={`${tableCls.rowHover} ${r.voided_at ? "opacity-45" : ""}`}>
                      <td className={`${tableCls.td} font-medium`}>{siteLabel(r.site_id)}</td>
                      <td className={tableCls.td}>{renderShiftTypeCell(r.shift_type_id)}</td>
                      <td className={tableCls.td}>{renderBrokerCell(r.broker_id)}</td>
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
                          <Button variant="secondary" size="sm"
                            type="button"
                            onClick={() => onUnvoid(r.id)}

                          >
                            解除作廢
                          </Button>
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
            {visibleRows.map((r) => {
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${r.voided_at ? "opacity-45" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zk-base font-medium text-zk-text">{siteLabel(r.site_id)}</span>
                    <span className="text-zk-base tabular-nums text-zk-text">{hasClientRate ? fmtMoney(r.client_rate) : "—"}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-zk-xs text-zk-muted">
                    {renderShiftTypeCell(r.shift_type_id)}
                    {r.broker_id && renderBrokerCell(r.broker_id)}
                    <span>{guardLabel(r.guard_id)}</span>
                  </div>
                  <div className="mt-1 text-zk-xs text-zk-muted">
                    出街 {hasPayoutRate ? fmtMoney(r.payout_rate) : "—"} · 生效 {fmtDate(r.effective_from)}–{r.effective_to ? fmtDate(r.effective_to) : "無限期"}
                  </div>
                  <div className="mt-2">
                    {r.voided_at ? (
                      <Button variant="secondary" size="sm" type="button" onClick={() => onUnvoid(r.id)}>
                        解除作廢
                      </Button>
                    ) : (
                      <ConfirmVoidButton onConfirm={(reason) => onVoid(r.id, reason)} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-zk-sm text-zk-muted">
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
            {/* M2：shiftTypes 而家係全站一次 load（唔再逐 site 攞），
                揀盤入面淨係揀返呢個 site_id 底下嘅更別。 */}
            <select className={selectCls} value={form.shift_type_id} onChange={(e) => setForm((f) => ({ ...f, shift_type_id: e.target.value }))}>
              <option value="">（通用）</option>
              {shiftTypes
                .filter((s) => s.site_id === form.site_id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="雞頭" hint="留空＝通用">
            {/* M2：brokers 而家包含 inactive（顯示用）——新增/揀價目淨
                係俾揀有效雞頭，已停用嘅唔應該再畀人新配。 */}
            <select className={selectCls} value={form.broker_id} onChange={(e) => setForm((f) => ({ ...f, broker_id: e.target.value }))}>
              <option value="">（通用）</option>
              {brokers
                .filter((b) => b.status !== "inactive")
                .map((b) => (
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
          {/* WP-PHASE3（item 4）：揀咗 OT 更種（code 開頭 "OT"）就提示卡金額
              單位——WP-BOSS5 §25.1（老闆 2026-09-28 決定 1）已經拍板。 */}
          {shiftTypes.find((s) => s.id === form.shift_type_id)?.code?.startsWith("OT") && (
            <div className="rounded-[7px] border border-zk-warning-border bg-zk-warning-bg px-2.5 py-1.5 text-zk-sm text-zk-warning-dark">
              老闆 2026-09-28 決定：OT 卡金額＝每小時價，系統寫入時已乘 OT 時數（2026-08-01 起嘅記錄；淨係 1 個鐘嘅 OT 同「每條記錄」睇落一樣）。人手直接輸入嘅 OT snapshot（唔經呢張卡自動計）一律當「該條記錄金額」，唔會再乘時數。
            </div>
          )}
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
          <Field label="結算模式（billing_model，必填）">
            <select className={selectCls} value={form.billing_model} onChange={(e) => setForm((f) => ({ ...f, billing_model: e.target.value }))} required>
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
          <DrawerFormFooter saving={saving} onCancel={() => setDrawerOpen(false)} />
        </form>
      </Drawer>
    </div>
  );
}
