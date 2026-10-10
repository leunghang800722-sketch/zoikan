"use client";
// P2-A：保安員名冊頁（README §08）——換皮，邏輯／API 呼叫全部保留；
// 加「本月更數」欄（GET /api/guards?with_month_shifts=YYYY-MM，additive
// 唯讀參數，見 src/app/api/guards/route.ts）同「搜尋 姓名/工號/電話」
// filter（純前端篩選 rows，唔加新 API）。雞頭登入呢頁本身已經淨係見自
// 己保安員（API scopeGuardWhere() 隔離，未改）。
//
// A3（Opus 整合驗收）：呢個 client component 由 `./page.tsx`（server
// component，攞 session）傳 `isBroker` 落嚟，跟 `my-receivable` 果頁
// 同一個 pattern——雞頭 session 頁首 kicker 要顯示「我的」（跟
// `src/lib/rbac/nav.ts` 導航分組），唔可以再寫死「主檔」。
//
// P3-5.2：原本單檔 ~2,640 行，拆成（純搬移，行為零改變，testid 不變）：
//   GuardsClient.tsx   容器（名冊 state／載入／停用恢復）
//   GuardsFilters.tsx  頁頂欄          GuardsTable.tsx  桌面表＋手機卡（分頁 render）
//   GuardDrawer.tsx    Drawer 容器＋tab 組合（drawer/*：基本／證件／聯絡／長工／銀行）
//   useGuardForm.ts    表單／開關／儲存（+ useGuardStaffNumbers／useGuardContacts／useGuardLongterm）
//   guards-types.ts／guards-utils.ts
import { useEffect, useRef, useState } from "react";
import { apiRequest, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";
import { Banner } from "@/components/ui/Banner";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { useMonthState } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import type { BrokerRow, GuardRow, SiteRow } from "./guards-types";
import { GuardDrawer } from "./GuardDrawer";
import { GuardsFilters, type IdentityFilter } from "./GuardsFilters";
import { GuardsTable } from "./GuardsTable";
import { useGuardForm } from "./useGuardForm";

export function GuardsClient({
  isBroker,
  canUpdateSettlement,
  canUpdatePii,
  canUpdateBank,
  canOcr = false,
}: {
  isBroker: boolean;
  // WP-PII（Opus 驗收必修 2）：呢三個係「呢個 session 而家有冇對應
  // field-group 嘅 update 權」（`hasPermission(session, mod, "update")`，
  // 喺 server component `page.tsx` 計好傳落嚟）——onSubmit() 用嚟決定
  // PATCH body 入唔入嗰組欄位，同 `hasMoneyField`/`hasPiiField`/
  // `hasBankField`（response 有冇嗰粒 key，即係「有冇 view」）唔同一件
  // 事：淨係有 view 冇 update 嘅角色會見到個 input（可以打字），但撳
  // 「儲存」唔應該將嗰組欄位（即使值冇變）送落 body，唔係就會撞返
  // assertFieldGroupWritable() 嘅 403（見 GuardsClient.tsx onSubmit()）。
  canUpdateSettlement: boolean;
  canUpdatePii: boolean;
  canUpdateBank: boolean;
  /** WP-GUARD-OCR §29：有 DEEPSEEK_API_KEY 同「保安員批量導入」權限先顯示「用證件新增」 */
  canOcr?: boolean;
}) {
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
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
  // 搜尋框 placeholder：列表 row 有 `hkid` key（＝session 有「保安員個人資料」view，API 先會用 q 配身份證）
  // 先顯示「身份證」；預設 false（唔洩露權限），有 row 先更新，冇 row 保持上一個值。
  const [searchHasHkid, setSearchHasHkid] = useState(false);
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
  const [month, setMonth, monthReady] = useMonthState();
  // WP-PII：「牌照／平安卡 90 日內到期」FilterChip——`?expiring_within_days=90`
  // （API 早已經 OR 埋 safety_card_expiry，見 src/app/api/guards/route.ts；
  // 呢度改嘅淨係文案＋表格 pill 顯示，唔使改 API）。
  const [expiringOnly, setExpiringOnly] = useState(false);
  // WP-STAFF-IMPORT B1：識別狀態篩選（缺身份證／缺電話）。
  const [identityFilter, setIdentityFilter] = useState<IdentityFilter>("");
  // WP-PHASE3（§20.4 Phase 3 item 1）：保安員抽屜「長工」區——崗位盤（`GET/
  // POST/PATCH /api/guards/:id/longterm-posts`）。`sites` 淨係揀盤下拉用
  // （呢頁之前完全冇載盤清單）。
  const [sites, setSites] = useState<SiteRow[]>([]);

  const g = useGuardForm({
    isBroker,
    rows,
    canUpdateSettlement,
    canUpdatePii,
    canUpdateBank,
    hasLicenceExtraField,
    setHasPiiField,
    setHasBankField,
    setHasLicenceExtraField,
    askConfirm,
    setNotice,
    reloadList: () => load(search),
  });

  // S7（Opus 驗收）：搜尋改由 server 做（`GET /api/guards?q=`）——原本
  // 純前端 `matchesSearch()` 淨係篩得到已經攞落嚟嗰批 rows 嘅 additive
  // `staff_numbers`（淨係 current），搵唔到 former（已取消，已經摺埋）
  // 嘅號。Server 端 `q` 用 `guard_staff_numbers`（唔限 status）搵，仲會標
  // `former_number_hit`。
  // P3-2.7（P11／B-6）：每次 load 帶 request id＋AbortController——後發先至嘅舊 response 唔會蓋新結果；
  // brokers／sites 唔再跟搜尋重拉（見下面 mount-only effect，經 60 s lookup cache）。
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  async function load(q: string) {
    const seq = ++loadSeqRef.current;
    loadAbortRef.current?.abort();
    const ctrl = new AbortController();
    loadAbortRef.current = ctrl;
    setLoading(true);
    setError(null);
    const expiringParam = expiringOnly ? "&expiring_within_days=90" : "";
    // 搜尋字可能係身份證號：唔放 URL（避免落 access log／瀏覽器歷史），改用 request header（encodeURIComponent）
    const qHeaders = q.trim() ? { "x-guard-search": encodeURIComponent(q.trim()) } : undefined;
    const identityParam = identityFilter ? `&identity=${identityFilter}` : "";
    const guardRes = await apiRequest<ApiListResult<GuardRow>>(`/api/guards?take=500&with_month_shifts=${month}${expiringParam}${identityParam}`, {
      headers: qHeaders,
      signal: ctrl.signal,
    });
    if (seq !== loadSeqRef.current) return; // 已有更新嘅一次 load，呢個舊 response 丟棄
    // B-5（階段 1 驗收員補充）：保安員 >500 時 `take=500` 會靜靜截斷——逐頁拉齊 `total`。
    // （skip 按頁前進；有啲 session 嘅 DTO 轉換會喺分頁後剔走個別行，唔可以用 rows.length 做 skip。）
    for (let skip = 500; guardRes.ok && skip < guardRes.data.total; skip += 500) {
      const next = await apiRequest<ApiListResult<GuardRow>>(
        `/api/guards?take=500&skip=${skip}&with_month_shifts=${month}${expiringParam}${identityParam}`,
        { headers: qHeaders, signal: ctrl.signal },
      );
      if (seq !== loadSeqRef.current) return;
      if (!next.ok || next.data.rows.length === 0) break;
      guardRes.data.rows.push(...next.data.rows);
    }
    if (!guardRes.ok) {
      setError(guardRes.message);
      setLoading(false);
      return;
    }
    setRows(guardRes.data.rows);
    // `hasMoneyField` 唔受呢個 race 影響（`monthly_salary` 唔喺
    // GUARD_LIST_DETAIL_ONLY_FIELDS，列表 DTO 一直有；創建模式都要用
    // 呢粒 flag），照舊逢 `load()` 就更新。
    setHasMoneyField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "monthly_salary" in r));
    if (!g.editingDrawerRef.current) {
      setHasPiiField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "hkid" in r));
      if (guardRes.data.rows.length > 0) setSearchHasHkid(guardRes.data.rows.some((r) => "hkid" in r));
      setHasBankField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "bank_name" in r));
      setHasLicenceExtraField(guardRes.data.rows.length === 0 ? !isBroker : guardRes.data.rows.some((r) => "sia_permit_no" in r));
    }
    setLoading(false);
  }


  // P3-2.7：brokers／sites 淨係 mount 拉一次（共用 lookup cache），唔跟搜尋／篩選重拉。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [brokerRes, siteRes] = await Promise.all([
        cachedGetAll<BrokerRow>("/api/brokers"),
        // WP-PHASE3：淨係內部角色先揀到盤（雞頭 session「盤」module 硬性
        // 拒絕，403 都冇所謂——`sites` 保持空陣列，「長工」分區本身雞頭都
        // 見唔到）。
        isBroker ? Promise.resolve({ ok: false as const, status: 0, error: "", message: "" }) : cachedGetAll<SiteRow>("/api/sites"),
      ]);
      if (cancelled) return;
      if (brokerRes.ok) setBrokers(brokerRes.data.rows);
      if (siteRes.ok) setSites(siteRes.data.rows);
    })();
    return () => {
      cancelled = true;
      loadAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // S7：搜尋字打緊嗰陣 debounce 300ms 先 fetch（唔係逐個字都打一次
  // API）；月份／90日篩選改變唔使等（用戶撳完期望即刻反映，呢兩個唔會
  // 好似打字咁密集），但為咗淨係得一條 effect 管全部 reload、邏輯簡單
  // 啲，一律用同一個 debounce（300ms 用戶感覺唔到延遲）。
  // WP-RECONCILE-UI（§33.3 D）：deep link `?q=<名或工號>` 只係預填搜尋框（純 UI，唔寫入）。
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && q.trim()) setSearch(q.trim());
  }, []);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    const t = setTimeout(() => load(search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, expiringOnly, identityFilter, search, monthReady]);

  async function onVoid(id: string, reason: string) {
    setError(null);
    const res = await apiPost(`/api/guards/${id}/void`, { reason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已停用");
    await load(search);
  }

  async function onUnvoid(id: string) {
    setError(null);
    const res = await apiPost(`/api/guards/${id}/unvoid`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已恢復");
    await load(search);
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      <GuardsFilters
        isBroker={isBroker}
        canOcr={canOcr}
        search={search}
        setSearch={setSearch}
        searchHasHkid={searchHasHkid}
        month={month}
        setMonth={setMonth}
        expiringOnly={expiringOnly}
        setExpiringOnly={setExpiringOnly}
        identityFilter={identityFilter}
        setIdentityFilter={setIdentityFilter}
        openCreate={g.openCreate}
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {/* A5：呢頁保安員名冊本身唔按月份篩（`rows` 唔會因為改月份而變
          空），「呢個月零資料」講嘅係「本月更數」呢一欄——全部保安員
          嗰個月都冇更（唔係名冊冇人）。 */}
      <EmptyMonthNotice month={month} isEmpty={!loading && rows.length > 0 && rows.every((r) => !r.month_shift_count)} onJump={setMonth} />

      <GuardsTable
        rows={rows}
        loading={loading}
        search={search}
        resetKey={[search, expiringOnly, identityFilter].join("|")}
        brokers={brokers}
        onEdit={g.openEdit}
        onVoid={onVoid}
        onUnvoid={onUnvoid}
      />

      <GuardDrawer
        g={g}
        rows={rows}
        brokers={brokers}
        sites={sites}
        isBroker={isBroker}
        hasMoneyField={hasMoneyField}
        hasPiiField={hasPiiField}
        hasBankField={hasBankField}
        hasLicenceExtraField={hasLicenceExtraField}
      />
    </div>
  );
}
