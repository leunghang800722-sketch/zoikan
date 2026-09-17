"use client";
// P2-A：保安員名冊頁（README §08）——換皮，邏輯／API 呼叫全部保留；
// 加「本月更數」欄（GET /api/guards?with_month_shifts=YYYY-MM，additive
// 唯讀參數，見 src/app/api/guards/route.ts）同「搜尋 姓名/工號/電話」
// filter（純前端篩選 rows，唔加新 API）。雞頭登入呢頁本身已經淨係見自
// 己安員（API scopeGuardWhere() 隔離，未改）。
//
// A3（Opus 整合驗收）：呢個 client component 由 `./page.tsx`（server
// component，攞 session）傳 `isBroker` 落嚟，跟 `my-receivable` 果頁
// 同一個 pattern——雞頭 session 頁首 kicker 要顯示「我的」（跟
// `src/lib/rbac/nav.ts` 導航分組），唔可以再寫死「主檔」。
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
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmt, fmtDate, isExpired, isExpiringSoon, currentMonthStr } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { kickerFor } from "@/lib/ui/nav-active";

const EMPLOYMENT_TYPES = ["cash_casual", "longterm_autopay", "external", "casual_event"] as const;
// WP-PII（老闆 2026-09-17 拍板）：牌照類別白名單、Blacklist check 結果
// 白名單——同 src/lib/api/schemas.ts 嘅 zod enum 一致。
const SIA_PERMIT_TYPES = ["A", "B", "C", "D"] as const;
const BLACKLIST_RESULTS = ["clear", "flagged", "pending"] as const;
const BLACKLIST_LABEL: Record<string, string> = { clear: "已核實、無案底", flagged: "有紀錄", pending: "審查緊" };

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
  // WP-PII：新欄一律 optional——response 有冇呢粒 key 視乎 field-group
  // gate（冇「安員個人資料/安員銀行資料:view」成粒 key 都唔會出現，
  // 唔係值做 null），見 src/lib/api/field-groups.ts。
  hkid?: string | null;
  date_of_birth?: string | null;
  address?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_tel?: string | null;
  sia_permit_no?: string | null;
  sia_permit_type?: string | null;
  safety_card_no?: string | null;
  safety_card_expiry?: string | null;
  hire_date?: string | null;
  leave_date?: string | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_payee_name?: string | null;
  blacklist_check_result?: string | null;
  blacklist_check_date?: string | null;
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
  // WP-PII——淨係編輯（PATCH）先會夾落 body，見 onSubmit()。
  hkid: "",
  date_of_birth: "",
  address: "",
  emergency_contact_name: "",
  emergency_contact_tel: "",
  sia_permit_no: "",
  sia_permit_type: "",
  safety_card_no: "",
  safety_card_expiry: "",
  hire_date: "",
  leave_date: "",
  bank_name: "",
  bank_account_no: "",
  bank_payee_name: "",
  blacklist_check_result: "",
  blacklist_check_date: "",
};

function matchesSearch(g: GuardRow, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return [g.name_zh, g.staff_no, g.tel].some((v) => v && String(v).toLowerCase().includes(needle));
}

export function GuardsClient({ isBroker }: { isBroker: boolean }) {
  const [rows, setRows] = useState<GuardRow[]>([]);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasMoneyField, setHasMoneyField] = useState(true);
  // WP-PII：跟 hasMoneyField 一致嘅手法——response 有冇呢粒 key（field-
  // group gate 嘅結果）決定編輯抽屜顯唔顯示嗰個分區，唔靠前端自己判斷
  // 權限（單一事實來源：backend response 形狀）。
  const [hasPiiField, setHasPiiField] = useState(true);
  const [hasBankField, setHasBankField] = useState(true);
  // WP-PII：牌照/平安卡/入職離職日期（GuardCreateSchema 冇，PATCH-only）
  // 新增嗰幾隻 input——雞頭（`isBroker`）嘅 `GUARD_BROKER_FIELDS` 白名單
  // 本身唔包含呢啲欄，response 冇 key，同 hasPiiField/hasBankField 一致
  // 嘅「response 形狀決定顯唔顯示」手法，等雞頭視角自動零變化（唔使
  // 額外寫 `!isBroker` 分支）。
  const [hasLicenceExtraField, setHasLicenceExtraField] = useState(true);
  const [search, setSearch] = useState("");
  // S3（Opus 驗收修復）：原本冇 setter，月份寫死；而家加返 setter＋月份
  // FilterChip，改月份要重新 fetch `with_month_shifts`（見下面 useEffect
  // dep）。
  const [month, setMonth] = useState(currentMonthStr());
  // WP-PII：「牌照 90 日內到期」FilterChip——`?expiring_within_days=90`。
  const [expiringOnly, setExpiringOnly] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    const expiringParam = expiringOnly ? "&expiring_within_days=90" : "";
    const [guardRes, brokerRes] = await Promise.all([
      apiGet<ApiListResult<GuardRow>>(`/api/guards?take=500&with_month_shifts=${month}${expiringParam}`),
      apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
    ]);
    if (!guardRes.ok) {
      setError(guardRes.message);
      setLoading(false);
      return;
    }
    setRows(guardRes.data.rows);
    setHasMoneyField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "monthly_salary" in r));
    setHasPiiField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "hkid" in r));
    setHasBankField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "bank_name" in r));
    setHasLicenceExtraField(guardRes.data.rows.length === 0 ? !isBroker : guardRes.data.rows.some((r) => "sia_permit_no" in r));
    if (brokerRes.ok) setBrokers(brokerRes.data.rows);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, expiringOnly]);

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

  function fillFormFromRow(row: GuardRow) {
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
      hkid: row.hkid ?? "",
      date_of_birth: row.date_of_birth ? row.date_of_birth.slice(0, 10) : "",
      address: row.address ?? "",
      emergency_contact_name: row.emergency_contact_name ?? "",
      emergency_contact_tel: row.emergency_contact_tel ?? "",
      sia_permit_no: row.sia_permit_no ?? "",
      sia_permit_type: row.sia_permit_type ?? "",
      safety_card_no: row.safety_card_no ?? "",
      safety_card_expiry: row.safety_card_expiry ? row.safety_card_expiry.slice(0, 10) : "",
      hire_date: row.hire_date ? row.hire_date.slice(0, 10) : "",
      leave_date: row.leave_date ? row.leave_date.slice(0, 10) : "",
      bank_name: row.bank_name ?? "",
      bank_account_no: row.bank_account_no ?? "",
      bank_payee_name: row.bank_payee_name ?? "",
      blacklist_check_result: row.blacklist_check_result ?? "",
      blacklist_check_date: row.blacklist_check_date ? row.blacklist_check_date.slice(0, 10) : "",
    });
  }

  async function openEdit(row: GuardRow) {
    // WP-PII：列表嘅 `row.hkid` 係遮罩版（`A123***(7)`）——編輯抽屜要
    // 顯示全號（「詳情/編輯有權先見全號」），要重新 GET 單項詳情
    // （`GET /api/guards/:id` 冇做遮罩）。先用列表嗰行起草（即刻開抽屜
    // 唔使等），detail 攞到先補正確嘅 hkid（同其他欄——detail 同 list
    // 理論上其他欄一致，淨係 hkid 唔同）。
    setEditingId(row.id);
    fillFormFromRow(row);
    setFormError(null);
    setDrawerOpen(true);
    const detailRes = await apiGet<GuardRow>(`/api/guards/${row.id}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
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

    // WP-PII：新欄一律 PATCH-only（`GuardCreateSchema` 冇呢批欄，
    // POST body 帶咗會 400）——`editingId` 有值（編輯）先夾落 body，
    // 而且淨係揀個別欄有值先送（空字串唔送，等用戶部分填都得，唔會
    // 逼佢一次過填晒先儲得到）。分區冇顯示（`hasPiiField`/`hasBankField`
    // false）就完全唔會夾落嚟——冇「安員個人資料/安員銀行資料:update」
    // 嘅角色本身睇唔到呢啲 input，唔會誤送。
    if (editingId) {
      if (hasPiiField) {
        if (form.hkid) body.hkid = form.hkid;
        if (form.date_of_birth) body.date_of_birth = form.date_of_birth;
        if (form.address) body.address = form.address;
        if (form.emergency_contact_name) body.emergency_contact_name = form.emergency_contact_name;
        if (form.emergency_contact_tel) body.emergency_contact_tel = form.emergency_contact_tel;
        if (form.blacklist_check_result) body.blacklist_check_result = form.blacklist_check_result;
        if (form.blacklist_check_date) body.blacklist_check_date = form.blacklist_check_date;
      }
      if (hasBankField) {
        if (form.bank_name) body.bank_name = form.bank_name;
        if (form.bank_account_no) body.bank_account_no = form.bank_account_no;
        if (form.bank_payee_name) body.bank_payee_name = form.bank_payee_name;
      }
      // 牌照/平安卡/入職離職日期跟現有「安員」module，唔受 hasPiiField/
      // hasBankField 影響（有 `安員:update` 就見得/改得到）；
      // hasLicenceExtraField 一樣係「response 形狀」判斷，雞頭冇呢批
      // key，自動唔會夾落 body。
      if (hasLicenceExtraField) {
        if (form.sia_permit_no) body.sia_permit_no = form.sia_permit_no;
        if (form.sia_permit_type) body.sia_permit_type = form.sia_permit_type;
        if (form.safety_card_no) body.safety_card_no = form.safety_card_no;
        if (form.safety_card_expiry) body.safety_card_expiry = form.safety_card_expiry;
        if (form.hire_date) body.hire_date = form.hire_date;
        if (form.leave_date) body.leave_date = form.leave_date;
      }
    }

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

  // WP-PII：牌照到期三態 pill——過期紅、90 日內橙、冇填灰「未填」
  // （`isExpiringSoon()` 帶 90 日門檻，見 src/lib/ui/format.ts；已過期
  // 嘅 diffDays 係負數，一樣會 `<=90`，但呢度優先判 `isExpired` 出紅）。
  function licenceExpiryPill(expiry?: string | null) {
    if (!expiry) return <Pill variant="neutral">未填</Pill>;
    if (isExpired(expiry)) return <Pill variant="danger">已過期</Pill>;
    if (isExpiringSoon(expiry, 90)) return <Pill variant="warning">90 日內</Pill>;
    return <Pill variant="success">有效</Pill>;
  }

  const visibleRows = rows.filter((r) => matchesSearch(r, search));
  // S2：加返「聘用形式」欄——8 欄變 9 欄。
  const colCount = 9;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/guards", isBroker)}
        title="保安員"
        subtitle="牌照 90 日內到期或已過期嘅列會高亮。"
        actions={
          <>
            <FilterChip label="搜尋" showCaret={false}>
              <input type="text" placeholder="姓名 / 工號 / 電話" value={search} onChange={(e) => setSearch(e.target.value)} className="w-36" />
            </FilterChip>
            <FilterChip label="本月更數月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            {/* WP-PII：老闆決定「雞頭視角完全唔變」——呢個新 FilterChip
                淨係內部角色顯示，雞頭個 toolbar 保持原樣。 */}
            {!isBroker && (
              <FilterChip label="牌照 90 日內到期" showCaret={false}>
                <input type="checkbox" checked={expiringOnly} onChange={(e) => setExpiringOnly(e.target.checked)} />
              </FilterChip>
            )}
            <Button variant="primary" onClick={openCreate}>
              新增保安員
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {/* A5：呢頁保安員名冊本身唔按月份篩（`rows` 唔會因為改月份而變
          空），「呢個月零資料」講嘅係「本月更數」呢一欄——全部保安員
          嗰個月都冇更（唔係名冊冇人）。 */}
      <EmptyMonthNotice month={month} isEmpty={!loading && rows.length > 0 && rows.every((r) => !r.month_shift_count)} onJump={setMonth} />

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
                  <th className={tableCls.th}>牌照到期</th>
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
                      <td className={tableCls.td}>{statusPill(r)}</td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {licenceExpiryPill(r.sia_permit_expiry)}
                          <span className="text-[11.5px] text-zk-muted">{fmtDate(r.sia_permit_expiry)}</span>
                        </div>
                      </td>
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
                    {licenceExpiryPill(r.sia_permit_expiry)}
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

          {/* WP-PII：新欄一律 PATCH-only（見上面 onSubmit()）——新增
              保安員嗰陣（`!editingId`）唔顯示呢幾個分區，建好之後先用
              「編輯」補（避免顯示一啲 POST 唔接受嘅 input，撳「儲存」
              先發現 400）。冇對應 view 權限嘅分區直接唔顯示（唔係顯示
              「—」，跟老闆決定原文）。 */}
          {editingId && hasLicenceExtraField && (
            <>
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">牌照與證件</h3>
              <div className="grid grid-cols-2 gap-2">
                <Field label="牌照號碼">
                  <input className={inputCls} value={form.sia_permit_no} onChange={(e) => setForm((f) => ({ ...f, sia_permit_no: e.target.value }))} />
                </Field>
                <Field label="牌照類別">
                  <select className={selectCls} value={form.sia_permit_type} onChange={(e) => setForm((f) => ({ ...f, sia_permit_type: e.target.value }))}>
                    <option value="">（未填）</option>
                    {SIA_PERMIT_TYPES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="平安卡號碼">
                  <input className={inputCls} value={form.safety_card_no} onChange={(e) => setForm((f) => ({ ...f, safety_card_no: e.target.value }))} />
                </Field>
                <Field label="平安卡到期日">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.safety_card_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, safety_card_expiry: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="入職日期">
                  <input type="date" className={inputCls} value={form.hire_date} onChange={(e) => setForm((f) => ({ ...f, hire_date: e.target.value }))} />
                </Field>
                <Field label="離職日期">
                  <input type="date" className={inputCls} value={form.leave_date} onChange={(e) => setForm((f) => ({ ...f, leave_date: e.target.value }))} />
                </Field>
              </div>
            </>
          )}

          {editingId && hasPiiField && (
            <>
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">個人資料</h3>
              <Field label="身份證號碼" hint="格式例：A123456(7)">
                <input className={inputCls} value={form.hkid} onChange={(e) => setForm((f) => ({ ...f, hkid: e.target.value }))} />
              </Field>
              <Field label="出生日期">
                <input type="date" className={inputCls} value={form.date_of_birth} onChange={(e) => setForm((f) => ({ ...f, date_of_birth: e.target.value }))} />
              </Field>
              <Field label="地址">
                <input className={inputCls} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="緊急聯絡人姓名">
                  <input
                    className={inputCls}
                    value={form.emergency_contact_name}
                    onChange={(e) => setForm((f) => ({ ...f, emergency_contact_name: e.target.value }))}
                  />
                </Field>
                <Field label="緊急聯絡人電話" hint="8 位數字">
                  <input
                    className={inputCls}
                    value={form.emergency_contact_tel}
                    onChange={(e) => setForm((f) => ({ ...f, emergency_contact_tel: e.target.value }))}
                  />
                </Field>
              </div>

              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">Blacklist</h3>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Check 結果">
                  <select
                    className={selectCls}
                    value={form.blacklist_check_result}
                    onChange={(e) => setForm((f) => ({ ...f, blacklist_check_result: e.target.value }))}
                  >
                    <option value="">（未填）</option>
                    {BLACKLIST_RESULTS.map((v) => (
                      <option key={v} value={v}>
                        {BLACKLIST_LABEL[v]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Check 日期">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.blacklist_check_date}
                    onChange={(e) => setForm((f) => ({ ...f, blacklist_check_date: e.target.value }))}
                  />
                </Field>
              </div>
            </>
          )}

          {editingId && hasBankField && (
            <>
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">銀行</h3>
              <Field label="銀行">
                <input className={inputCls} value={form.bank_name} onChange={(e) => setForm((f) => ({ ...f, bank_name: e.target.value }))} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="戶口號碼">
                  <input className={inputCls} value={form.bank_account_no} onChange={(e) => setForm((f) => ({ ...f, bank_account_no: e.target.value }))} />
                </Field>
                <Field label="收款人名">
                  <input className={inputCls} value={form.bank_payee_name} onChange={(e) => setForm((f) => ({ ...f, bank_payee_name: e.target.value }))} />
                </Field>
              </div>
            </>
          )}

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
