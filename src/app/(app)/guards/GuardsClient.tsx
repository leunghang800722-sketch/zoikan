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
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost, apiDelete, type ApiListResult } from "@/lib/ui/api-client";
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
import { fmt, fmtDate, isExpired, isExpiringSoon, currentMonthStr, todayLocalStr } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import { kickerFor } from "@/lib/ui/nav-active";

const EMPLOYMENT_TYPES = ["cash_casual", "longterm_autopay", "external", "casual_event"] as const;
const BLACKLIST_RESULTS = ["clear", "flagged", "pending"] as const;
const BLACKLIST_LABEL: Record<string, string> = { clear: "已核實、無案底", flagged: "有紀錄", pending: "審查緊" };
// WP-STAFFNO（老闆 2026-09-19 拍板）：已知嘅員工編號 scheme——U＝去
// Wilson 盤做散工必須有；MP＝去第二間公司嘅盤做散工用；MG＝轉咗長工；
// MW＝公司寫字樓員工編號（office staff，唔係前線保安；老闆 2026-09-19 確認）。UI 下拉用呢個列表＋「其他」（自填），
// 對應 API 嗰邊唔寫死 enum（zod regex 1-4 位大寫英文字母），將來加新
// 種類淨係改呢個陣列，唔使改 API。
const KNOWN_STAFF_NUMBER_SCHEMES = ["U", "MP", "MG", "MW"] as const;

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
  // WP-STAFFNO：衍生值——兩者「仍然有效而最早到期」嗰個，由
  // `deriveSiaPermitExpiry()`（後台）計，列表 pill／90 日篩選繼續用呢個。
  sia_permit_expiry?: string | null;
  sia_permit_type?: string | null;
  // 必修 4（Opus 驗收第三輪）：乙類因為滿 70 歲法定失效嗰陣，
  // `sia_permit_expiry`/`sia_permit_type` 都會變 null，同「完全冇填」
  // 睇落一樣——呢個衍生 flag（唔係 PII）令列表/抽屜可以分開顯示「乙類
  // 已失效」，唔會誤顯示做「未填」，見 src/lib/guards/staff-numbers.ts
  // isSiaPermitBLapsedByAge()。
  sia_permit_b_lapsed_by_age?: boolean;
  polo_size?: string | null;
  status: string;
  month_shift_count?: number;
  // WP-STAFFNO：additive，淨係 current（chips 用）——冇 key 就當「未攞到
  // （唔會發生，冇 gate）」，見 src/app/api/guards/route.ts。
  staff_numbers?: Array<{ scheme: string; number: string; status: string }>;
  // S7：淨係有 `?q=` 先有呢粒 key——呢個保安員入面有一個舊（former）號
  // 撞中咗搜尋字。
  former_number_hit?: boolean;
  // WP-PII：新欄一律 optional——response 有冇呢粒 key 視乎 field-group
  // gate（冇「安員個人資料/安員銀行資料:view」成粒 key 都唔會出現，
  // 唔係值做 null），見 src/lib/api/field-groups.ts。
  hkid?: string | null;
  date_of_birth?: string | null;
  address?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_tel?: string | null;
  sia_permit_no?: string | null;
  // WP-STAFFNO：甲／乙類到期日分開存——跟現有「安員」module（PATCH-only，
  // 同 sia_permit_no 一致層級）。
  sia_permit_a_expiry?: string | null;
  sia_permit_b_expiry?: string | null;
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
// WP-STAFFNO：`GET/POST /api/guards/:id/staff-numbers` 嘅一行。
interface StaffNumberRow {
  id: string;
  scheme: string;
  number: string;
  status: "current" | "former";
  valid_from?: string | null;
  valid_to?: string | null;
  note?: string | null;
}

// WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）：
// `GET/POST /api/guards/:id/phones`／`emergency-contacts`／`addresses`
// 嘅一行——雞頭讀電話用窄版 DTO（冇 note/source/created_by），呢個
// interface 全部欄都做 optional 兼容兩種 DTO。
interface PhoneRow {
  id: string;
  tel: string;
  label?: string | null;
  is_primary: boolean;
  note?: string | null;
}
interface AddressRow {
  id: string;
  address: string;
  is_primary: boolean;
  note?: string | null;
}
interface ContactRow {
  id: string;
  name?: string | null;
  tel?: string | null;
  relationship?: string | null;
  sort_order: number;
  note?: string | null;
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
  polo_size: "",
  // WP-PII——淨係編輯（PATCH）先會夾落 body，見 onSubmit()。
  hkid: "",
  date_of_birth: "",
  address: "",
  emergency_contact_name: "",
  emergency_contact_tel: "",
  sia_permit_no: "",
  // WP-STAFFNO：甲／乙類到期日——淨係編輯先會夾落 body，`sia_permit_
  // type` 唔喺呢度（衍生值，API 唔接受寫，顯示直接讀 row，見
  // fillFormFromRow()）。
  sia_permit_a_expiry: "",
  sia_permit_b_expiry: "",
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

const emptyStaffNumberForm = {
  scheme: KNOWN_STAFF_NUMBER_SCHEMES[0] as string,
  schemeOther: "",
  number: "",
  valid_from: "",
  note: "",
};

// WP-MULTI：三個新分區各自嘅「新增」表單初始值。
const emptyPhoneForm = { tel: "", label: "", note: "" };
const emptyAddressForm = { address: "", note: "" };
const emptyContactForm = { name: "", tel: "", relationship: "", note: "" };

export function GuardsClient({
  isBroker,
  canUpdateSettlement,
  canUpdatePii,
  canUpdateBank,
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
}) {
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
  // WP-PII：「牌照／平安卡 90 日內到期」FilterChip——`?expiring_within_days=90`
  // （API 早已經 OR 埋 safety_card_expiry，見 src/app/api/guards/route.ts；
  // 呢度改嘅淨係文案＋表格 pill 顯示，唔使改 API）。
  const [expiringOnly, setExpiringOnly] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Fable5.1（4 個細修 4，防資料被抹）：`openEdit()` 先用列表 row 起草
  // form（即刻開抽屜），detail GET（`/api/guards/:id`）先真正攞到
  // date_of_birth／blacklist_check_date（同其他 detail-only 欄——列表
  // DTO 冇呢批欄，見 src/lib/api/dto/index.ts GUARD_LIST_DETAIL_ONLY_
  // FIELDS），但 `onSubmit()` 呢兩個欄一律 `|| null` 送——如果 detail
  // GET 未返嚟就撳「儲存」，空字串會被當做「用戶想清空」，永久毀走已有
  // 資料。`detailLoaded`：detail GET 呢個 request 已經完成（成功定失敗
  // 都算），Save 掣喺呢個變 true 之前 disabled；`detailAvailable`：淨係
  // detail GET 真係成功先 true，`onSubmit()` 用嚟決定送唔送 detail-only
  // 欄（失敗——包括 403 冇權睇／500——一律唔送，key 唔出現喺 body，等
  // PATCH 部分更新唔會掂呢批欄）。新增模式（`openCreate()`）唔涉及呢個
  // 問題，兩個都直接 true。
  const [detailLoaded, setDetailLoaded] = useState(true);
  const [detailAvailable, setDetailAvailable] = useState(true);

  // WP-STAFFNO：員工編號獨立表——編輯抽屜開嗰陣先另外 GET
  // `/api/guards/:id/staff-numbers`（current+former），唔喺主列表/詳情
  // 攞（列表淨係 additive 嘅 current chips）。雞頭（`isBroker`）淨係讀
  // （冇「新增編號」表單，見下面 render）。
  const [staffNumbers, setStaffNumbers] = useState<StaffNumberRow[]>([]);
  const [staffNumberForm, setStaffNumberForm] = useState(emptyStaffNumberForm);
  const [staffNumberError, setStaffNumberError] = useState<string | null>(null);
  const [staffNumberSaving, setStaffNumberSaving] = useState(false);
  // 已取消（former）號預設摺埋——「顯示已取消嘅號 N 個」撳咗先展開。
  const [showFormerStaffNumbers, setShowFormerStaffNumbers] = useState(false);
  // S7：每行員工編號「取消呢個號」／「改返現用」／「編輯（號碼／生效期／
  // 備註）」——`numberEditingId` 有值就顯示緊嗰行嘅 inline 編輯表單。
  const [numberActionBusy, setNumberActionBusy] = useState(false);
  const [numberActionError, setNumberActionError] = useState<string | null>(null);
  const [numberEditingId, setNumberEditingId] = useState<string | null>(null);
  const [numberEditForm, setNumberEditForm] = useState({ number: "", valid_from: "", valid_to: "", note: "" });
  // WP-STAFFNO：`sia_permit_type`（A／B／A+B）而家係衍生顯示值，唔喺
  // `form` 度（唔會送落 PATCH body）——淨係讀 row 顯示俾用戶睇，改甲／
  // 乙到期日之後要重新 GET 先會見到新值（同其他衍生欄一致，唔喺前端
  // 重複算一次）。
  const [derivedSiaPermitType, setDerivedSiaPermitType] = useState<string | null>(null);
  // 必修 3（Opus 驗收第三輪）：a／b 都未填、但 row 仲存住舊
  // `sia_permit_expiry`／`sia_permit_type` 嘅 guard——抽屜要顯示一行唯讀
  // 提示（「舊記錄：類別 X、到期 YYYY-MM-DD」），等用戶知呢個人其實有
  // 舊牌照資料，淨係未搬去新嘅甲／乙到期日兩欄（設計原則：舊牌照資料
  // 除非用戶明確填咗甲／乙到期日，否則任何一層都唔准改，見
  // src/lib/guards/staff-numbers.ts canOverrideDerivedSiaPermit()）。
  // 冇呢種情況（a／b 其中一個有值，或者舊值本身都冇）就 null，唔顯示。
  const [legacyPermitInfo, setLegacyPermitInfo] = useState<{ type: string | null; expiry: string | null } | null>(null);

  // WP-MULTI（老闆 2026-09-19 拍板）：電話——「主要電話照舊喺頂」＝上面
  // `form.tel`（舊寫法，經 PATCH /api/guards/:id 走 legacy path，見
  // src/lib/guards/contacts.ts applyLegacyGuardContactPatch()），呢度
  // 加多一個分區列晒所有電話（`GET .../phones`，主要 pill／label／設為
  // 主要／編輯／刪除／新增）。雞頭（isBroker）淨係讀（冇新增/編輯/刪除
  // 掣，同員工編號分區一致 UX）。
  const [phones, setPhones] = useState<PhoneRow[]>([]);
  const [phoneForm, setPhoneForm] = useState(emptyPhoneForm);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneActionBusy, setPhoneActionBusy] = useState(false);
  const [phoneActionError, setPhoneActionError] = useState<string | null>(null);
  const [phoneEditingId, setPhoneEditingId] = useState<string | null>(null);
  const [phoneEditForm, setPhoneEditForm] = useState({ tel: "", label: "", note: "" });

  // WP-MULTI：地址——同電話一致嘅分區手法（primary pill）。
  const [addresses, setAddresses] = useState<AddressRow[]>([]);
  const [addressForm, setAddressForm] = useState(emptyAddressForm);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressActionBusy, setAddressActionBusy] = useState(false);
  const [addressActionError, setAddressActionError] = useState<string | null>(null);
  const [addressEditingId, setAddressEditingId] = useState<string | null>(null);
  const [addressEditForm, setAddressEditForm] = useState({ address: "", note: "" });

  // WP-MULTI：緊急聯絡人——冇「主要」概念，用 sort_order 排先後（列表
  // 已經跟 `GET .../emergency-contacts` 排好序，唔使前端再排一次）。
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactForm, setContactForm] = useState(emptyContactForm);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactActionBusy, setContactActionBusy] = useState(false);
  const [contactActionError, setContactActionError] = useState<string | null>(null);
  const [contactEditingId, setContactEditingId] = useState<string | null>(null);
  const [contactEditForm, setContactEditForm] = useState({ name: "", tel: "", relationship: "", note: "" });

  // Fable5.1（驗證期間揭發嘅 pre-existing race，順手一齊修——同 P0 前端
  // 唔准掂 migration.sql 一致，呢個都係純前端）：`hasPiiField`／
  // `hasBankField`／`hasLicenceExtraField` 淨係編輯抽屜（`editingId &&
  // drawerOpen`）先用得著。但用戶喺搜尋框打字嗰陣，`load()` 會 debounce
  // 300ms 之後喺背景重新 fetch 列表——列表 DTO 結構上永遠冇 bank_name／
  // hkid／sia_permit_no 呢批 detail-only 欄（GUARD_LIST_DETAIL_ONLY_
  // FIELDS，見 src/lib/api/dto/index.ts），如果呢個背景 reload 嘅
  // response 遲過 `openEdit()` 嘅 detail GET 先返嚟，就會將 `openEdit()`
  // 啱啱靠 detail 正確設低嘅 `true` 屈返做 `false`，令抽屜開緊嗰陣
  // 「個人資料」／「銀行」／「牌照與證件」分區突然消失。用一個 ref（唔
  // 受閉包影響，`load()` 個 async response 返嚟嗰刻讀到嘅一定係最新值）
  // 記住「而家係咪編輯緊現有記錄」，`load()` 呢三個 setter 喺呢種情況下
  // 跳過（抽屜已經有 detail 嘅更準確答案，唔應該畀一個純粹為咗「搜尋」
  // 先觸發嘅背景 reload 蓋過）。
  const editingDrawerRef = useRef(false);
  useEffect(() => {
    editingDrawerRef.current = drawerOpen && !!editingId;
  }, [drawerOpen, editingId]);

  // S7（Opus 驗收）：搜尋改由 server 做（`GET /api/guards?q=`）——原本
  // 純前端 `matchesSearch()` 淨係篩得到已經攞落嚟嗰批 rows 嘅 additive
  // `staff_numbers`（淨係 current），搵唔到 former（已取消，已經摺埋）
  // 嘅號。Server 端 `q` 用 `guard_staff_numbers`（唔限 status）搵，仲會標
  // `former_number_hit`。
  async function load(q: string) {
    setLoading(true);
    setError(null);
    const expiringParam = expiringOnly ? "&expiring_within_days=90" : "";
    const qParam = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
    const [guardRes, brokerRes] = await Promise.all([
      apiGet<ApiListResult<GuardRow>>(`/api/guards?take=500&with_month_shifts=${month}${expiringParam}${qParam}`),
      apiGet<ApiListResult<BrokerRow>>("/api/brokers?take=500"),
    ]);
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
    if (!editingDrawerRef.current) {
      setHasPiiField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "hkid" in r));
      setHasBankField(guardRes.data.rows.length === 0 ? true : guardRes.data.rows.some((r) => "bank_name" in r));
      setHasLicenceExtraField(guardRes.data.rows.length === 0 ? !isBroker : guardRes.data.rows.some((r) => "sia_permit_no" in r));
    }
    if (brokerRes.ok) setBrokers(brokerRes.data.rows);
    setLoading(false);
  }

  // S7：搜尋字打緊嗰陣 debounce 300ms 先 fetch（唔係逐個字都打一次
  // API）；月份／90日篩選改變唔使等（用戶撳完期望即刻反映，呢兩個唔會
  // 好似打字咁密集），但為咗淨係得一條 effect 管全部 reload、邏輯簡單
  // 啲，一律用同一個 debounce（300ms 用戶感覺唔到延遲）。
  useEffect(() => {
    const t = setTimeout(() => load(search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, expiringOnly, search]);

  function broker(id?: string | null): BrokerRow | undefined {
    if (!id) return undefined;
    return brokers.find((x) => x.id === id);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setStaffNumbers([]);
    setStaffNumberForm(emptyStaffNumberForm);
    setStaffNumberError(null);
    setShowFormerStaffNumbers(false);
    setNumberEditingId(null);
    setNumberActionError(null);
    setDerivedSiaPermitType(null);
    setLegacyPermitInfo(null);
    // WP-MULTI：新增保安員嗰陣個 guard 仲未存在，三張新表分區同員工編號
    // 分區一致——淨係編輯先顯示，呢度重置返晒空。
    setPhones([]);
    setPhoneForm(emptyPhoneForm);
    setPhoneError(null);
    setPhoneEditingId(null);
    setPhoneActionError(null);
    setAddresses([]);
    setAddressForm(emptyAddressForm);
    setAddressError(null);
    setAddressEditingId(null);
    setAddressActionError(null);
    setContacts([]);
    setContactForm(emptyContactForm);
    setContactError(null);
    setContactEditingId(null);
    setContactActionError(null);
    // 新增模式冇 detail GET 呢個問題（PII/銀行呢批欄新增表單本身都冇），
    // 兩個都直接 true——Save 掣唔應該因為呢個防護機制喺新增模式度 disabled。
    setDetailLoaded(true);
    setDetailAvailable(true);
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
      polo_size: row.polo_size ?? "",
      hkid: row.hkid ?? "",
      date_of_birth: row.date_of_birth ? row.date_of_birth.slice(0, 10) : "",
      address: row.address ?? "",
      emergency_contact_name: row.emergency_contact_name ?? "",
      emergency_contact_tel: row.emergency_contact_tel ?? "",
      sia_permit_no: row.sia_permit_no ?? "",
      sia_permit_a_expiry: row.sia_permit_a_expiry ? row.sia_permit_a_expiry.slice(0, 10) : "",
      sia_permit_b_expiry: row.sia_permit_b_expiry ? row.sia_permit_b_expiry.slice(0, 10) : "",
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
    if ("sia_permit_type" in row) setDerivedSiaPermitType(row.sia_permit_type ?? null);
    // 必修 3：a／b 都未填（form 個兩隻 input 都會係空字串）、但 row 仲存
    // 住舊 `sia_permit_expiry`／`sia_permit_type` 嘅任何一個 → 顯示舊記錄
    // 提示；唔係就 null（唔顯示）。
    const aEmpty = !row.sia_permit_a_expiry;
    const bEmpty = !row.sia_permit_b_expiry;
    if (aEmpty && bEmpty && (row.sia_permit_expiry || row.sia_permit_type)) {
      setLegacyPermitInfo({ type: row.sia_permit_type ?? null, expiry: row.sia_permit_expiry ? row.sia_permit_expiry.slice(0, 10) : null });
    } else {
      setLegacyPermitInfo(null);
    }
  }

  // WP-STAFFNO：抽屜開緊嗰個人嘅員工編號（current+former），俾「員工
  // 編號」分區用。
  async function loadStaffNumbers(guardId: string) {
    const res = await apiGet<StaffNumberRow[]>(`/api/guards/${guardId}/staff-numbers`);
    if (res.ok) setStaffNumbers(res.data);
  }

  // WP-MULTI：抽屜開緊嗰個人嘅電話／地址／緊急聯絡人——冇權（403，例如
  // 雞頭睇地址／緊急聯絡人）就保持空陣列，對應分區靠 `hasPiiField`／
  // `isBroker` 唔顯示，唔靠呢度嘅 fetch 結果判斷顯唔顯示。
  async function loadPhones(guardId: string) {
    const res = await apiGet<PhoneRow[]>(`/api/guards/${guardId}/phones`);
    setPhones(res.ok ? res.data : []);
  }
  async function loadAddresses(guardId: string) {
    const res = await apiGet<AddressRow[]>(`/api/guards/${guardId}/addresses`);
    setAddresses(res.ok ? res.data : []);
  }
  async function loadContacts(guardId: string) {
    const res = await apiGet<ContactRow[]>(`/api/guards/${guardId}/emergency-contacts`);
    setContacts(res.ok ? res.data : []);
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
    setStaffNumberForm(emptyStaffNumberForm);
    setStaffNumberError(null);
    setShowFormerStaffNumbers(false);
    setNumberEditingId(null);
    setNumberActionError(null);
    // WP-MULTI：重置返三張新表分區嘅 inline 編輯／表單狀態（同上面
    // openCreate() 一致），實際資料靠下面 `loadPhones()`／
    // `loadAddresses()`／`loadContacts()` 攞。
    setPhoneForm(emptyPhoneForm);
    setPhoneError(null);
    setPhoneEditingId(null);
    setPhoneActionError(null);
    setAddressForm(emptyAddressForm);
    setAddressError(null);
    setAddressEditingId(null);
    setAddressActionError(null);
    setContactForm(emptyContactForm);
    setContactError(null);
    setContactEditingId(null);
    setContactActionError(null);
    // Fable5.1（防資料被抹）：detail GET 呢個 request 未完成之前，Save
    // 掣要 disabled（見下面 JSX `disabled={saving || !detailLoaded}`）——
    // 列表 row 起草嘅 form，`date_of_birth`／`blacklist_check_date` 呢批
    // detail-only 欄一定係空字串，唔可以俾用戶喺呢段空窗期撳「儲存」將
    // 空字串當做「清空」送落 DB。
    setDetailLoaded(false);
    setDetailAvailable(false);
    setDrawerOpen(true);
    const detailRes = await apiGet<GuardRow>(`/api/guards/${row.id}`);
    if (detailRes.ok) {
      fillFormFromRow(detailRes.data);
      // WP-PII（應修 4 連帶）：列表 DTO 而家唔回銀行三欄/地址/出生日期/
      // 緊急聯絡人/Blacklist（見 src/lib/api/dto/index.ts
      // toGuardListDTO()），`hasBankField`/`hasPiiField` 之前靠列表 row
      // 有冇 `bank_name`/`hkid` 呢粒 key 判斷分區顯唔顯示——`bank_name`
      // 而家已經結構上唔會喺列表出現，靠列表判斷會令有權嘅角色都見唔到
      // 銀行分區。詳情 response（呢度）仍然用 toGuardFullDTO()，全欄
      // 照舊靠 field-group gate 決定有冇個 key，改用詳情嚟判斷先準確
      // （`hkid`/`sia_permit_no` 列表本身冇變，呢度覆蓋純粹為咗
      // `bank_name` 準，一致順便三個都用詳情覆蓋）。
      setHasPiiField("hkid" in detailRes.data);
      setHasBankField("bank_name" in detailRes.data);
      setHasLicenceExtraField("sia_permit_no" in detailRes.data);
      setDetailAvailable(true);
    } else {
      // Fable5.1：detail GET 失敗（包括 403 冇權睇、500）——`onSubmit()`
      // 唔會送任何 detail-only 欄（`detailAvailable` 保持 false），淨係
      // 送列表 DTO 本身有嘅欄，避免用錯（空）值清走 DB 已有資料。
      setDetailAvailable(false);
    }
    setDetailLoaded(true);
    await loadStaffNumbers(row.id);
    await Promise.all([loadPhones(row.id), loadAddresses(row.id), loadContacts(row.id)]);
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
      polo_size: form.polo_size || undefined,
    };
    if (!editingId) body.default_broker_id = form.default_broker_id || undefined;
    // WP-PII（Opus 驗收必修 2）：用 `canUpdateSettlement`（grants，出街
    // 價:update）唔用 `hasMoneyField`（view-based）——冇 update 權嘅角色
    // 就算見到個 input（有 view 冇 update），撳儲存都唔應該送
    // `monthly_salary` 落 body（同下面 PII/銀行兩組一致道理）。
    if (canUpdateSettlement && form.monthly_salary !== "") body.monthly_salary = Number(form.monthly_salary);

    // WP-PII：新欄一律 PATCH-only（`GuardCreateSchema` 冇呢批欄，
    // POST body 帶咗會 400）——`editingId` 有值（編輯）先夾落 body，
    // 而且淨係揀個別欄有值先送（空字串唔送，等用戶部分填都得，唔會
    // 逼佢一次過填晒先儲得到）。
    //
    // Opus 驗收必修 2：夾唔夾落 body 用 `canUpdatePii`/`canUpdateBank`
    // （grants，「安員個人資料/安員銀行資料:update」）判斷，唔用
    // `hasPiiField`/`hasBankField`（view-based，「response 有冇呢粒
    // key」）——後者純粹決定分區顯唔顯示；有 view 冇 update 嘅角色
    // （理論上出廠矩陣兩個 action 一致開關，但自訂角色可以拆開）見到
    // 個 input 但冇權寫，唔應該連冇改嗰組欄都送落 body 觸發
    // assertFieldGroupWritable() 嘅 403。
    if (editingId) {
      if (canUpdatePii) {
        if (form.hkid) body.hkid = form.hkid;
        // 應修 2（Opus 驗收第二輪）：出生日期／黑名單查核日期跟牌照/
        // 平安卡/入離職嗰 5 個日期欄一致——`GuardUpdateSchema` 已經改用
        // nullable schema（`null`＝清空），呢兩個欄一樣要一律送
        // （`|| null`），唔可以再「空就唔送」，否則用戶打空咗個已填日期
        // 想清返會清唔到。
        //
        // Fable5.1（防資料被抹）：`date_of_birth`／`address`／
        // `emergency_contact_name`／`emergency_contact_tel`／
        // `blacklist_check_result`／`blacklist_check_date` 呢 6 個欄全部
        // detail-only（列表 DTO 冇，見 openEdit() 頂註解）——用
        // `detailAvailable` 統一包住：detail GET 未成功過（都仲未完成，
        // 或者完成咗但失敗，包括 403/500）就一律唔送呢批欄（key 唔出現
        // 喺 body），交俾 PATCH 部分更新語意保護 DB 已有嘅值。Save 掣
        // 本身喺 detail GET 未完成之前已經 disabled（見下面 JSX），所以
        // `detailAvailable === false` 但撳得到「儲存」嗰陣，一定係 detail
        // GET 已經完成但失敗嗰個情況。
        if (detailAvailable) {
          body.date_of_birth = form.date_of_birth || null;
          if (form.address) body.address = form.address;
          if (form.emergency_contact_name) body.emergency_contact_name = form.emergency_contact_name;
          if (form.emergency_contact_tel) body.emergency_contact_tel = form.emergency_contact_tel;
          if (form.blacklist_check_result) body.blacklist_check_result = form.blacklist_check_result;
          body.blacklist_check_date = form.blacklist_check_date || null;
        }
      }
      if (canUpdateBank) {
        // Fable5.1：銀行三欄一樣 detail-only，同上同一個保護。
        if (detailAvailable) {
          if (form.bank_name) body.bank_name = form.bank_name;
          if (form.bank_account_no) body.bank_account_no = form.bank_account_no;
          if (form.bank_payee_name) body.bank_payee_name = form.bank_payee_name;
        }
      }
      // 牌照/平安卡/入職離職日期跟現有「安員」module，唔受 hasPiiField/
      // hasBankField 影響（有 `安員:update` 就見得/改得到）；
      // hasLicenceExtraField 一樣係「response 形狀」判斷，雞頭冇呢批
      // key，自動唔會夾落 body。
      if (hasLicenceExtraField) {
        if (form.sia_permit_no) body.sia_permit_no = form.sia_permit_no;
        // WP-STAFFNO：`sia_permit_type`／`sia_permit_expiry` 而家係衍生
        // 值，唔再送落 body（API 400）——改甲／乙到期日就得，後台自動
        // 重算，儲存之後 `load()`／`openEdit()` 重新 GET 會見到新值。
        //
        // 附帶修復（Opus 驗收）：呢 5 個日期欄而家一律送（`|| null`），
        // 唔再「空就唔送」——`GuardUpdateSchema` 已經改用 nullable
        // schema（`null`＝清空），用戶將 input 打空咗要真係清得走個已填
        // 日期，唔可以淨係「唔送呢個 key」（嗰種寫法後台會當「冇提
        // 供」，完全唔會清）。
        body.sia_permit_a_expiry = form.sia_permit_a_expiry || null;
        body.sia_permit_b_expiry = form.sia_permit_b_expiry || null;
        if (form.safety_card_no) body.safety_card_no = form.safety_card_no;
        body.safety_card_expiry = form.safety_card_expiry || null;
        body.hire_date = form.hire_date || null;
        body.leave_date = form.leave_date || null;
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
    await load(search);
  }

  // WP-STAFFNO：抽屜「員工編號」分區嘅「新增」——POST
  // `/api/guards/:id/staff-numbers`。淨係編輯（`editingId` 有值）先用得
  // 到（新增保安員嗰陣個 guard 仲未存在）；掛喺一個獨立 `type="button"`
  // 撳掣（唔係 nested `<form>` submit——HTML 唔准 form 入面再有 form，
  // 呢個分區本身喺編輯保安員嗰個大 `<form onSubmit={onSubmit}>` 入面）。
  async function onAddStaffNumber() {
    if (!editingId) return;
    setStaffNumberSaving(true);
    setStaffNumberError(null);
    const scheme = staffNumberForm.scheme === "其他" ? staffNumberForm.schemeOther.trim().toUpperCase() : staffNumberForm.scheme;
    const res = await apiPost<{ converted_former?: { number: string } | null }>(`/api/guards/${editingId}/staff-numbers`, {
      scheme,
      number: staffNumberForm.number,
      valid_from: staffNumberForm.valid_from || undefined,
      note: staffNumberForm.note || undefined,
    });
    setStaffNumberSaving(false);
    if (!res.ok) {
      setStaffNumberError(res.message);
      return;
    }
    setStaffNumberForm({ ...emptyStaffNumberForm, scheme: staffNumberForm.scheme });
    setNotice(
      res.data.converted_former
        ? `已新增 ${scheme} 號，原本嘅 ${res.data.converted_former.number} 已取消`
        : `已新增 ${scheme} 號`,
    );
    await loadStaffNumbers(editingId);
    await load(search); // 令列表 chips 即時反映新現用號
    // 主表單頂部嘅「工號」／「工號（MW）」（舊欄，PATCH 支援舊寫法）
    // 唔可以留低啱先起草嗰陣嘅舊值——如果新增咗 U／MG／MW 號，`guards.
    // staff_no`／`staff_no_mw` 已經由後台 `syncLegacyStaffNoColumns()`
    // 同步咗，主表單再唔重新 GET 就會停留喺舊值；到時撳「儲存」個 form
    // 會帶住呢個舊值一齊送，`PATCH /api/guards/:id` 會以為「想將個號改返
    // 舊嗰個」，同呢個 guard 自己頭先轉咗做 former 嗰行撞號（409）。
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // S7（Opus 驗收）：員工編號逐行「取消呢個號」／「改返現用」——一click
  // 切換 status（`current`↔`former`），call PATCH .../staff-numbers/:id。
  // 業務規則 (4)（老闆 2026-09-19 拍板）：離職後舊編號會取消，再入職攞
  // 全新編號，永遠唔復用舊號——所以「改返現用」（former→current）係
  // 反常操作，正常流程唔應該再用返一個已取消嘅號，加一個 `confirm()`
  // 防手震／防誤觸，撳之前一定要用戶明確確認先送 PATCH。
  async function onToggleStaffNumberStatus(row: StaffNumberRow) {
    if (!editingId) return;
    const nextStatus: "current" | "former" = row.status === "current" ? "former" : "current";
    if (nextStatus === "current") {
      const confirmed = window.confirm(
        `已取消嘅編號正常唔會再用（再入職會攞新號）。確定要將 ${row.number} 改返現用？（只應該用嚟更正撳錯）`,
      );
      if (!confirmed) return;
    }
    setNumberActionBusy(true);
    setNumberActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/staff-numbers/${row.id}`, { status: nextStatus });
    setNumberActionBusy(false);
    if (!res.ok) {
      setNumberActionError(res.message);
      return;
    }
    setNotice(nextStatus === "former" ? `已將 ${row.number} 取消` : `已將 ${row.number} 改返現用`);
    await loadStaffNumbers(editingId);
    await load(search);
    // 同 onAddStaffNumber() 一致理由——staff_no／staff_no_mw 可能經
    // syncLegacyStaffNoColumns() 同步咗，主表單要重新 GET 先唔會帶住
    // 舊值撳「儲存」撞號。
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // S7：「編輯」撳落去開 inline 表單（號碼／生效日期／備註），「編輯」
  // 撳多次都得——`openNumberEdit()` 淨係重設個 form 做嗰行現有值。
  function onOpenNumberEdit(row: StaffNumberRow) {
    setNumberEditingId(row.id);
    setNumberActionError(null);
    setNumberEditForm({
      number: row.number,
      valid_from: row.valid_from ? row.valid_from.slice(0, 10) : "",
      valid_to: row.valid_to ? row.valid_to.slice(0, 10) : "",
      note: row.note ?? "",
    });
  }

  function onCancelNumberEdit() {
    setNumberEditingId(null);
    setNumberActionError(null);
  }

  async function onSaveNumberEdit() {
    if (!editingId || !numberEditingId) return;
    setNumberActionBusy(true);
    setNumberActionError(null);
    // 應修 2（Opus 驗收第二輪）：`note`／`valid_from`／`valid_to` 而家
    // 一律送（`|| null`），唔再「空就唔送」——`GuardStaffNumberUpdateSchema`
    // 已經改用 nullable schema，用戶打空咗想清返呢三個欄要真係清得走。
    const res = await apiPatch(`/api/guards/${editingId}/staff-numbers/${numberEditingId}`, {
      number: numberEditForm.number,
      valid_from: numberEditForm.valid_from || null,
      valid_to: numberEditForm.valid_to || null,
      note: numberEditForm.note || null,
    });
    setNumberActionBusy(false);
    if (!res.ok) {
      setNumberActionError(res.message);
      return;
    }
    setNumberEditingId(null);
    setNotice("已更新員工編號");
    await loadStaffNumbers(editingId);
    await load(search);
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // WP-MULTI：主表單頂部嘅「電話」（舊欄，PATCH 支援舊寫法）撳「儲存」
  // 之後可能已經由 `syncLegacyGuardContactColumns()` 同步咗新值——同
  // `onAddStaffNumber()` 一致理由（見該函數註解），呢三張新表分區操作
  // 完之後一樣要重新 GET 詳情覆蓋返主表單，唔係就撳「儲存」會帶住舊值
  // 再撞一次 legacy path。
  async function refreshMainFormAfterContactChange() {
    if (!editingId) return;
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // -------------------------------------------------------------------
  // 電話
  // -------------------------------------------------------------------
  async function onAddPhone() {
    if (!editingId) return;
    setPhoneSaving(true);
    setPhoneError(null);
    const res = await apiPost<PhoneRow>(`/api/guards/${editingId}/phones`, {
      tel: phoneForm.tel,
      label: phoneForm.label || undefined,
      note: phoneForm.note || undefined,
    });
    setPhoneSaving(false);
    if (!res.ok) {
      setPhoneError(res.message);
      return;
    }
    setPhoneForm(emptyPhoneForm);
    setNotice("已新增電話");
    await loadPhones(editingId);
    await load(search);
    await refreshMainFormAfterContactChange();
  }

  async function onSetPhonePrimary(row: PhoneRow) {
    if (!editingId || row.is_primary) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/phones/${row.id}`, { is_primary: true });
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setNotice(`已將 ${row.tel} 設做主要電話`);
    await loadPhones(editingId);
    await load(search);
    await refreshMainFormAfterContactChange();
  }

  function onOpenPhoneEdit(row: PhoneRow) {
    setPhoneEditingId(row.id);
    setPhoneActionError(null);
    setPhoneEditForm({ tel: row.tel, label: row.label ?? "", note: row.note ?? "" });
  }
  function onCancelPhoneEdit() {
    setPhoneEditingId(null);
    setPhoneActionError(null);
  }
  async function onSavePhoneEdit() {
    if (!editingId || !phoneEditingId) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/phones/${phoneEditingId}`, {
      tel: phoneEditForm.tel,
      label: phoneEditForm.label || null,
      note: phoneEditForm.note || null,
    });
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setPhoneEditingId(null);
    setNotice("已更新電話");
    await loadPhones(editingId);
    await load(search);
    await refreshMainFormAfterContactChange();
  }

  async function onDeletePhone(row: PhoneRow) {
    if (!editingId) return;
    const confirmed = window.confirm(`確定要刪走電話 ${row.tel}？（更正打錯用，audit_log 留底）`);
    if (!confirmed) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/phones/${row.id}`);
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setNotice(`已刪走電話 ${row.tel}`);
    await loadPhones(editingId);
    await load(search);
    await refreshMainFormAfterContactChange();
  }

  // -------------------------------------------------------------------
  // 地址
  // -------------------------------------------------------------------
  async function onAddAddress() {
    if (!editingId) return;
    setAddressSaving(true);
    setAddressError(null);
    const res = await apiPost<AddressRow>(`/api/guards/${editingId}/addresses`, { address: addressForm.address, note: addressForm.note || undefined });
    setAddressSaving(false);
    if (!res.ok) {
      setAddressError(res.message);
      return;
    }
    setAddressForm(emptyAddressForm);
    setNotice("已新增地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onSetAddressPrimary(row: AddressRow) {
    if (!editingId || row.is_primary) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/addresses/${row.id}`, { is_primary: true });
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setNotice("已設做主要地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  function onOpenAddressEdit(row: AddressRow) {
    setAddressEditingId(row.id);
    setAddressActionError(null);
    setAddressEditForm({ address: row.address, note: row.note ?? "" });
  }
  function onCancelAddressEdit() {
    setAddressEditingId(null);
    setAddressActionError(null);
  }
  async function onSaveAddressEdit() {
    if (!editingId || !addressEditingId) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/addresses/${addressEditingId}`, { address: addressEditForm.address, note: addressEditForm.note || null });
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setAddressEditingId(null);
    setNotice("已更新地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onDeleteAddress(row: AddressRow) {
    if (!editingId) return;
    const confirmed = window.confirm("確定要刪走呢個地址？（更正打錯用，audit_log 留底）");
    if (!confirmed) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/addresses/${row.id}`);
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setNotice("已刪走地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  // -------------------------------------------------------------------
  // 緊急聯絡人
  // -------------------------------------------------------------------
  async function onAddContact() {
    if (!editingId) return;
    setContactSaving(true);
    setContactError(null);
    const res = await apiPost<ContactRow>(`/api/guards/${editingId}/emergency-contacts`, {
      name: contactForm.name || undefined,
      tel: contactForm.tel || undefined,
      relationship: contactForm.relationship || undefined,
      note: contactForm.note || undefined,
    });
    setContactSaving(false);
    if (!res.ok) {
      setContactError(res.message);
      return;
    }
    setContactForm(emptyContactForm);
    setNotice("已新增緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  function onOpenContactEdit(row: ContactRow) {
    setContactEditingId(row.id);
    setContactActionError(null);
    setContactEditForm({ name: row.name ?? "", tel: row.tel ?? "", relationship: row.relationship ?? "", note: row.note ?? "" });
  }
  function onCancelContactEdit() {
    setContactEditingId(null);
    setContactActionError(null);
  }
  async function onSaveContactEdit() {
    if (!editingId || !contactEditingId) return;
    setContactActionBusy(true);
    setContactActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/emergency-contacts/${contactEditingId}`, {
      name: contactEditForm.name || null,
      tel: contactEditForm.tel || null,
      relationship: contactEditForm.relationship || null,
      note: contactEditForm.note || null,
    });
    setContactActionBusy(false);
    if (!res.ok) {
      setContactActionError(res.message);
      return;
    }
    setContactEditingId(null);
    setNotice("已更新緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onDeleteContact(row: ContactRow) {
    if (!editingId) return;
    const confirmed = window.confirm(`確定要刪走呢個緊急聯絡人${row.name ? `（${row.name}）` : ""}？（更正打錯用，audit_log 留底）`);
    if (!confirmed) return;
    setContactActionBusy(true);
    setContactActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/emergency-contacts/${row.id}`);
    setContactActionBusy(false);
    if (!res.ok) {
      setContactActionError(res.message);
      return;
    }
    setNotice("已刪走緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  // 排序——撳「較先」/「較後」同鄰居互換 sort_order（PATCH 兩次；冇
  // unique constraint 擋住，短暫中間狀態安全）。
  async function onMoveContact(index: number, direction: -1 | 1) {
    if (!editingId) return;
    const target = contacts[index];
    const neighbour = contacts[index + direction];
    if (!target || !neighbour) return;
    setContactActionBusy(true);
    setContactActionError(null);
    const [r1, r2] = await Promise.all([
      apiPatch(`/api/guards/${editingId}/emergency-contacts/${target.id}`, { sort_order: neighbour.sort_order }),
      apiPatch(`/api/guards/${editingId}/emergency-contacts/${neighbour.id}`, { sort_order: target.sort_order }),
    ]);
    setContactActionBusy(false);
    if (!r1.ok || !r2.ok) {
      setContactActionError(!r1.ok ? r1.message : !r2.ok ? r2.message : "排序失敗");
      return;
    }
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

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

  function statusPill(g: GuardRow) {
    // Opus 覆核 S2：`staff_no` 舊欄而家會 fallback 顯示已取消嘅 U 號（保歷史
    // 更表／匯出），唔可以再用佢判斷「有冇工號」——睇現用 U 號（U 號係
    // 去 Wilson 盤開工嘅硬性要求）；冇 `staff_numbers`（舊 response）先退返舊欄。
    const hasCurrentU = g.staff_numbers ? g.staff_numbers.some((n) => n.scheme === "U" && n.status === "current") : !!g.staff_no;
    if (!hasCurrentU) return <Pill variant="warning">未有現用 U 號</Pill>;
    if (g.status === "active") return <Pill variant="success">在職</Pill>;
    return <Pill variant="neutral">{g.status}</Pill>;
  }

  // WP-STAFFNO：列表「工號」欄——由舊嘅單一 `staff_no` 文字改做逐個
  // scheme 一個 chip（`U…`／`MP…`／`MG…`，淨係 current，additive
  // `staff_numbers`，見 src/app/api/guards/route.ts）；冇任何現用號就
  // 「—」。
  function staffNumberChips(g: GuardRow) {
    const numbers = g.staff_numbers ?? [];
    return (
      <div className="flex flex-wrap items-center gap-1">
        {numbers.length === 0 ? <span className="text-zk-muted">—</span> : null}
        {numbers.map((n) => (
          <Pill key={`${n.scheme}:${n.number}`} variant="neutral">
            {n.number}
          </Pill>
        ))}
        {/* S7：靠一個已取消（former）號搵到嘅結果——標俾用戶知呢個人喺
            搜尋緊嗰個號其實已經取消（列表 chips 本身淨係顯示 current）。 */}
        {g.former_number_hit ? <Pill variant="warning">已取消號命中</Pill> : null}
      </div>
    );
  }

  // WP-STAFFNO：乙類牌照過 70 歲失效——編輯抽屜「乙類到期」旁邊灰字
  // 提示用（純前端顯示，真正「失效唔計」嘅邏輯喺後台
  // `deriveSiaPermitExpiry()`，呢度淨係為咗即時 UI 提示，冇 `now` 參數
  // 就用瀏覽器而家嗰刻，容許幾百毫秒嘅時區/時鐘噪音——呢個純粹係
  // 提示文字，唔影響實際存落 DB 嘅值）。
  // Fable5.1（4 個細修 3）：原本直接用 `now.getFullYear()`／`getMonth()`
  // （瀏覽器本地時區）計歲數，同後台 `ageAsOfHk()`（
  // src/lib/guards/staff-numbers.ts，一律用 `todayLocalStr()` 換做香港
  // 時區嘅 YYYY-MM-DD 先計）唔一致——HK 00:00–08:00 呢段時間，如果用戶
  // 部機本地時區唔係 HK（例如 UTC），前端提示可能同後台實際判斷差一
  // 日。改用 `todayLocalStr(now)` 一致計法。
  function isAge70OrOlder(dobStr: string, now: Date = new Date()): boolean {
    if (!dobStr) return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobStr);
    if (!m) return false;
    const [, y, mo, d] = m.map(Number) as unknown as [number, number, number, number];
    const [ty, tm, td] = todayLocalStr(now).split("-").map(Number);
    let age = ty - y;
    if (tm < mo || (tm === mo && td < d)) age -= 1;
    return age >= 70;
  }

  // WP-PII（可接受但順手）：牌照（sia_permit_expiry）／平安卡
  // （safety_card_expiry）兩個到期日一齊揀「較早」嗰一個嚟顯示/高亮——
  // 一個保安員可以牌照仲有效但平安卡就快到期（或者反過嚟），淨係睇
  // 牌照會漏警示。冇填嘅一邊當「冇呢個限制」，兩個都冇填先算「未填」。
  function earlierExpiry(a?: string | null, b?: string | null): string | null | undefined {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b; // "YYYY-MM-DD" 字串排序等同日期排序
  }

  // WP-PII：牌照/平安卡到期三態 pill——過期紅、90 日內橙、冇填灰「未填」
  // （`isExpiringSoon()` 帶 90 日門檻，見 src/lib/ui/format.ts；已過期
  // 嘅 diffDays 係負數，一樣會 `<=90`，但呢度優先判 `isExpired` 出紅）。
  // Fable5.1（4 個細修 1）：原本必修 4 個做法係將「乙類已失效」塞喺
  // `!expiry` 分支入面——但 `expiry` 呢度傳嘅係 `earlierExpiry(牌照,
  // 平安卡)`，安員平安卡（safety_card_expiry）仲有效嗰陣 `expiry` 就唔
  // 會係 falsy，成粒 pill 會跌落「有效」綠色分支，完全冚蓋咗「乙類已
  // 失效」呢個警示，用戶睇唔出。改法：`licenceExpiryPill()` 淨係反映
  // `expiry`（最近到期日）本身，「乙類已失效」拆做獨立
  // `siaPermitBLapsedPill()`，兩粒 pill 喺 call site 並排 render（桌面
  // 表格／手機卡都要），互不影響。
  function licenceExpiryPill(expiry?: string | null) {
    if (!expiry) return <Pill variant="neutral">未填</Pill>;
    if (isExpired(expiry)) return <Pill variant="danger">已過期</Pill>;
    if (isExpiringSoon(expiry, 90)) return <Pill variant="warning">90 日內</Pill>;
    return <Pill variant="success">有效</Pill>;
  }

  // Fable5.1：獨立嘅「乙類已失效（滿70歲）」警示 pill——同
  // `licenceExpiryPill()` 並排顯示，唔會被「有效」冚蓋（見上面註解）。
  function siaPermitBLapsedPill(bLapsedByAge?: boolean) {
    if (!bLapsedByAge) return null;
    return <Pill variant="warning">乙類已失效（滿70歲）</Pill>;
  }

  // S7（Opus 驗收）：`rows` 而家已經係 server 揀好嘅結果（`GET
  // /api/guards?q=`）——唔使再喺前端 filter 一次。
  const visibleRows = rows;
  // S2：加返「聘用形式」欄——8 欄變 9 欄。
  const colCount = 9;

  // S7：員工編號分區每行——顯示＋（!isBroker 先有）「取消呢個號」／
  // 「改返現用」／「編輯（號碼／生效期／備註）」，call PATCH
  // .../staff-numbers/:numberId。
  function renderStaffNumberRow(n: StaffNumberRow) {
    const isCurrent = n.status === "current";
    const isEditing = numberEditingId === n.id;
    return (
      <div
        key={n.id}
        className={`rounded-[7px] border px-2.5 py-1.5 text-[13px] ${isCurrent ? "border-zk-border" : "border-zk-border bg-zk-header text-zk-muted"}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="neutral">{n.scheme}</Pill>
          <span className={isCurrent ? "font-medium text-zk-text" : undefined}>{n.number}</span>
          <Pill variant={isCurrent ? "success" : "neutral"}>{isCurrent ? "現用" : "已取消"}</Pill>
          {/* WP-MULTI（老闆 2026-09-19 拍板業務規則 (4)）：每個編號有自己
              嘅入職／離職日期——標籤改用呢個講法，唔再淨係講「生效」/
              「取消」，等用戶睇得明「呢個係呢個號嘅入職/離職日期，唔係
              呢個人整體嘅」。 */}
          {isCurrent && n.valid_from && <span className="text-xs text-zk-muted">入職（呢個號）：{fmtDate(n.valid_from)}</span>}
          {!isCurrent && n.valid_to && <span className="text-xs">離職／取消：{fmtDate(n.valid_to)}</span>}
          {n.note && <span className="text-xs text-zk-muted">備註：{n.note}</span>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              <button
                type="button"
                disabled={numberActionBusy}
                onClick={() => onToggleStaffNumberStatus(n)}
                className="text-xs text-zk-primary underline"
              >
                {isCurrent ? "取消呢個號" : "改返現用"}
              </button>
              <button
                type="button"
                onClick={() => (isEditing ? onCancelNumberEdit() : onOpenNumberEdit(n))}
                className="text-xs text-zk-primary underline"
              >
                {isEditing ? "取消編輯" : "編輯"}
              </button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={numberActionError} />
            <Field label="號碼">
              <input className={inputCls} value={numberEditForm.number} onChange={(e) => setNumberEditForm((f) => ({ ...f, number: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              {/* WP-MULTI：`valid_from` 標籤改「入職日期（呢個號）」——
                  一個工號一行＝一組入職／離職日期，同「保安員整體」嘅
                  入職／離職日期（下面「牌照與證件」分區嗰兩個）分開。 */}
              <Field label="入職日期（呢個號）">
                <input
                  type="date"
                  className={inputCls}
                  value={numberEditForm.valid_from}
                  onChange={(e) => setNumberEditForm((f) => ({ ...f, valid_from: e.target.value }))}
                />
              </Field>
              {/* 應修 2（Opus 驗收第二輪）：取消自動填嘅 valid_to 之前
                  淨係顯示（renderStaffNumberRow 嗰行「離職／取消：」），
                  冇得喺呢個編輯表單度改／清——而家補返個 input，打空咗撳
                  「儲存」會送 null 清走（見 onSaveNumberEdit()）。 */}
              <Field label="離職／取消日期">
                <input
                  type="date"
                  className={inputCls}
                  value={numberEditForm.valid_to}
                  onChange={(e) => setNumberEditForm((f) => ({ ...f, valid_to: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="備註">
              <input className={inputCls} value={numberEditForm.note} onChange={(e) => setNumberEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <button type="button" disabled={numberActionBusy} onClick={onSaveNumberEdit} className={btnSecondary}>
                {numberActionBusy ? "儲存緊…" : "儲存"}
              </button>
              <button type="button" onClick={onCancelNumberEdit} className={btnSecondary}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // WP-MULTI：電話分區每行——主要 pill／label／（!isBroker 先有）「設為
  // 主要」／「編輯」／「刪除」，call PATCH/DELETE .../phones/:phoneId。
  function renderPhoneRow(p: PhoneRow) {
    const isEditing = phoneEditingId === p.id;
    return (
      <div key={p.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className={p.is_primary ? "font-medium text-zk-text" : undefined}>{p.tel}</span>
          {p.is_primary ? <Pill variant="success">主要</Pill> : null}
          {p.label && <Pill variant="neutral">{p.label}</Pill>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              {!p.is_primary && (
                <button type="button" disabled={phoneActionBusy} onClick={() => onSetPhonePrimary(p)} className="text-xs text-zk-primary underline">
                  設為主要
                </button>
              )}
              <button type="button" onClick={() => (isEditing ? onCancelPhoneEdit() : onOpenPhoneEdit(p))} className="text-xs text-zk-primary underline">
                {isEditing ? "取消編輯" : "編輯"}
              </button>
              <button type="button" disabled={phoneActionBusy} onClick={() => onDeletePhone(p)} className="text-xs text-red-600 underline">
                刪除
              </button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={phoneActionError} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="號碼">
                <input className={inputCls} value={phoneEditForm.tel} onChange={(e) => setPhoneEditForm((f) => ({ ...f, tel: e.target.value }))} />
              </Field>
              <Field label="標籤（選填）" hint="例：本人／屋企／WhatsApp">
                <input className={inputCls} value={phoneEditForm.label} onChange={(e) => setPhoneEditForm((f) => ({ ...f, label: e.target.value }))} />
              </Field>
            </div>
            <Field label="備註（選填）">
              <input className={inputCls} value={phoneEditForm.note} onChange={(e) => setPhoneEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <button type="button" disabled={phoneActionBusy} onClick={onSavePhoneEdit} className={btnSecondary}>
                {phoneActionBusy ? "儲存緊…" : "儲存"}
              </button>
              <button type="button" onClick={onCancelPhoneEdit} className={btnSecondary}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // WP-MULTI：地址分區每行——同電話一致嘅 primary pill 手法。
  function renderAddressRow(a: AddressRow) {
    const isEditing = addressEditingId === a.id;
    return (
      <div key={a.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className={a.is_primary ? "font-medium text-zk-text" : undefined}>{a.address}</span>
          {a.is_primary ? <Pill variant="success">主要</Pill> : null}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              {!a.is_primary && (
                <button type="button" disabled={addressActionBusy} onClick={() => onSetAddressPrimary(a)} className="text-xs text-zk-primary underline">
                  設為主要
                </button>
              )}
              <button type="button" onClick={() => (isEditing ? onCancelAddressEdit() : onOpenAddressEdit(a))} className="text-xs text-zk-primary underline">
                {isEditing ? "取消編輯" : "編輯"}
              </button>
              <button type="button" disabled={addressActionBusy} onClick={() => onDeleteAddress(a)} className="text-xs text-red-600 underline">
                刪除
              </button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={addressActionError} />
            <Field label="地址">
              <input className={inputCls} value={addressEditForm.address} onChange={(e) => setAddressEditForm((f) => ({ ...f, address: e.target.value }))} />
            </Field>
            <Field label="備註（選填）">
              <input className={inputCls} value={addressEditForm.note} onChange={(e) => setAddressEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <button type="button" disabled={addressActionBusy} onClick={onSaveAddressEdit} className={btnSecondary}>
                {addressActionBusy ? "儲存緊…" : "儲存"}
              </button>
              <button type="button" onClick={onCancelAddressEdit} className={btnSecondary}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // WP-MULTI：緊急聯絡人分區每行——冇「主要」，用「較先」/「較後」兩粒
  // 箭嘴掣同鄰居互換 sort_order（`index` 係喺 `contacts`（已經跟
  // sort_order 排好序）入面嘅位置）。
  function renderContactRow(c: ContactRow, index: number) {
    const isEditing = contactEditingId === c.id;
    return (
      <div key={c.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          {index === 0 && <Pill variant="success">代表（同步落舊欄）</Pill>}
          <span className="font-medium text-zk-text">{c.name || "（未填姓名）"}</span>
          {c.tel && <span className="text-zk-muted">{c.tel}</span>}
          {c.relationship && <Pill variant="neutral">{c.relationship}</Pill>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              <button type="button" disabled={contactActionBusy || index === 0} onClick={() => onMoveContact(index, -1)} className="text-xs text-zk-primary underline disabled:opacity-40">
                較先
              </button>
              <button
                type="button"
                disabled={contactActionBusy || index === contacts.length - 1}
                onClick={() => onMoveContact(index, 1)}
                className="text-xs text-zk-primary underline disabled:opacity-40"
              >
                較後
              </button>
              <button type="button" onClick={() => (isEditing ? onCancelContactEdit() : onOpenContactEdit(c))} className="text-xs text-zk-primary underline">
                {isEditing ? "取消編輯" : "編輯"}
              </button>
              <button type="button" disabled={contactActionBusy} onClick={() => onDeleteContact(c)} className="text-xs text-red-600 underline">
                刪除
              </button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={contactActionError} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="姓名">
                <input className={inputCls} value={contactEditForm.name} onChange={(e) => setContactEditForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="電話">
                <input className={inputCls} value={contactEditForm.tel} onChange={(e) => setContactEditForm((f) => ({ ...f, tel: e.target.value }))} />
              </Field>
            </div>
            <Field label="關係（選填）" hint="例：配偶／父母／子女">
              <input className={inputCls} value={contactEditForm.relationship} onChange={(e) => setContactEditForm((f) => ({ ...f, relationship: e.target.value }))} />
            </Field>
            <Field label="備註（選填）">
              <input className={inputCls} value={contactEditForm.note} onChange={(e) => setContactEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <button type="button" disabled={contactActionBusy} onClick={onSaveContactEdit} className={btnSecondary}>
                {contactActionBusy ? "儲存緊…" : "儲存"}
              </button>
              <button type="button" onClick={onCancelContactEdit} className={btnSecondary}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/guards", isBroker)}
        title="保安員"
        subtitle="牌照／平安卡 90 日內到期或已過期嘅列會高亮。"
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
              <FilterChip label="牌照／平安卡 90 日內到期" showCaret={false}>
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
                  // WP-PII（可接受但順手）：牌照／平安卡兩個到期日取較早
                  // 嗰個嚟判斷高亮/顯示，見 earlierExpiry() 頂註解。
                  const nearestExpiry = earlierExpiry(r.sia_permit_expiry, r.safety_card_expiry);
                  const expired = isExpired(nearestExpiry);
                  const b = broker(r.default_broker_id);
                  return (
                    <tr key={r.id} className={`${tableCls.rowHover} ${expired ? tableCls.warnRow : ""}`}>
                      <td className={`${tableCls.td} font-medium`}>{r.name_zh}</td>
                      <td className={tableCls.td}>{staffNumberChips(r)}</td>
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
                          {licenceExpiryPill(nearestExpiry)}
                          {siaPermitBLapsedPill(r.sia_permit_b_lapsed_by_age)}
                          <span className="text-[11.5px] text-zk-muted">{fmtDate(nearestExpiry)}</span>
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
              const nearestExpiry = earlierExpiry(r.sia_permit_expiry, r.safety_card_expiry);
              const expired = isExpired(nearestExpiry);
              const b = broker(r.default_broker_id);
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${expired ? "bg-[#fef2f2]" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{r.name_zh}</span>
                    <span className="text-[13px] tabular-nums text-zk-text">{r.month_shift_count ?? "—"} 更</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-zk-muted">
                    {staffNumberChips(r)}
                    <span>{fmt(r.tel)}</span>
                    <span>{fmt(r.employment_type)}</span>
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                    {statusPill(r)}
                    {licenceExpiryPill(nearestExpiry)}
                    {siaPermitBLapsedPill(r.sia_permit_b_lapsed_by_age)}
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
            {/* S1（Opus 驗收）：呢兩個係快速路（同步落 guards.staff_no／
                staff_no_mw），淨係收固定種類——U／MG／MW 以外嘅種類（例如
                MP）要落面「員工編號」分區新增，唔係就 API 會 400。 */}
            {/* hint 文字刻意唔用「員工編號」呢個字眼（雖然指緊嗰個分區）——
                Playwright e2e（tests/e2e/staffno.spec.ts fieldControl()）
                淨係靠 `label` 嘅 `hasText` 子字串 + `.first()` 揾返落面
                「員工編號」分區入面真正嘅「編號」input，`hint` 文字入面
                字面出現「編號」呢兩個字會令佢誤中呢個較前面嘅 label，撳
                「新增編號」個掣（`!staffNumberForm.number` 都仲係空）保持
                disabled，成個 POST 都唔會發出——見 fieldControl() 註解。 */}
            <Field label="工號" hint="更表／匯出顯示嘅 U 號；只收 U 開頭。如果現用 U 號已取消，呢度會顯示最近取消嗰個（歷史更表用）——現用狀態以下面獨立分區為準">
              <input className={inputCls} value={form.staff_no} onChange={(e) => setForm((f) => ({ ...f, staff_no: e.target.value }))} />
            </Field>
            <Field label="長工／寫字樓工號（MG／MW）" hint="只作內部出糧／行政用；只收 MG／MW 開頭。現用狀態以下面獨立分區為準">
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

          {/* WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀
              一個」）：主要電話照舊喺頂（above），呢度加多一個分區列晒
              所有電話（有幾多個記幾多個）。新增保安員嗰陣（!editingId）
              個 guard 仲未存在，同員工編號分區一致淨係編輯先顯示。 */}
          {editingId && (
            <>
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">所有電話</h3>
              {phones.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄電話</div>
              ) : (
                <div className="space-y-1.5">{phones.map(renderPhoneRow)}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={phoneError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="新增電話號碼">
                      <input className={inputCls} value={phoneForm.tel} onChange={(e) => setPhoneForm((f) => ({ ...f, tel: e.target.value }))} placeholder="例：61234567" />
                    </Field>
                    <Field label="標籤（選填）" hint="例：本人／屋企／WhatsApp">
                      <input className={inputCls} value={phoneForm.label} onChange={(e) => setPhoneForm((f) => ({ ...f, label: e.target.value }))} />
                    </Field>
                  </div>
                  <button type="button" disabled={phoneSaving || !phoneForm.tel} onClick={onAddPhone} className={`${btnSecondary} mt-2`}>
                    {phoneSaving ? "新增緊…" : "新增電話"}
                  </button>
                </div>
              )}
            </>
          )}

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
                {/* WP-STAFFNO：牌照類別而家係衍生顯示值（由甲／乙類到期日
                    計，見 src/lib/guards/staff-numbers.ts
                    deriveSiaPermitExpiry()）——唔再係可以自己揀嘅
                    select，改甲／乙到期日、儲存之後重新 GET 先會見到
                    新值。 */}
                <Field label="牌照類別（自動計）">
                  <div className={`${inputCls} flex items-center bg-zk-header text-zk-muted`}>{derivedSiaPermitType ?? "—"}</div>
                </Field>
              </div>
              {/* 必修 3（Opus 驗收第三輪）：a／b 都未填但仲存住舊
                  `sia_permit_expiry`／`sia_permit_type` 嘅 guard——顯示
                  一行唯讀提示，等用戶知呢個人其實有舊牌照資料，淨係未
                  搬去新嘅甲／乙到期日兩欄；填咗任何一個之後（撳「儲存」
                  重新 GET）呢行就會自動消失，改用新計法。 */}
              {legacyPermitInfo && (
                <div className="rounded-[7px] border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[13px] text-amber-800">
                  舊記錄：類別 {legacyPermitInfo.type ?? "—"}、到期 {legacyPermitInfo.expiry ?? "—"}
                  （填咗甲／乙類到期日之後會改用新計法）
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label="甲類到期">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.sia_permit_a_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, sia_permit_a_expiry: e.target.value }))}
                  />
                </Field>
                <Field
                  label="乙類到期"
                  hint={isAge70OrOlder(form.date_of_birth) ? "已滿 70 歲，乙類失效" : undefined}
                >
                  <input
                    type="date"
                    className={inputCls}
                    value={form.sia_permit_b_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, sia_permit_b_expiry: e.target.value }))}
                  />
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
              {/* WP-MULTI：呢兩個係「保安員層面」（整體）嘅入職／離職日期——
                  跟下面「員工編號」分區每個號自己嘅入職／離職日期（見
                  renderStaffNumberRow）唔同層級，加 hint 講明分別。 */}
              <div className="grid grid-cols-2 gap-2">
                {/* Fable5.1：hint 刻意避免出現「編號」兩字——Playwright
                    e2e `fieldControl(page,"編號")`（tests/e2e/staffno.
                    spec.ts）用 `hasText` 揀返個「編號」input，佢會撞中
                    呢兩個欄嘅 hint 文字（連同呢個 label 底下嘅成段文字
                    一齊比對），令佢揀錯去呢度（type="date"）唔係下面
                    工號分區果個真正嘅「編號」文字 input。 */}
                <Field label="入職日期" hint="呢個係保安員整體嘅入職日期；每個工號仲有自己獨立嘅入職日期，見下面「員工工號」分區">
                  <input type="date" className={inputCls} value={form.hire_date} onChange={(e) => setForm((f) => ({ ...f, hire_date: e.target.value }))} />
                </Field>
                <Field label="離職日期" hint="呢個係保安員整體嘅離職日期；每個工號仲有自己獨立嘅離職／取消日期">
                  <input type="date" className={inputCls} value={form.leave_date} onChange={(e) => setForm((f) => ({ ...f, leave_date: e.target.value }))} />
                </Field>
              </div>
            </>
          )}

          {/* WP-STAFFNO：員工編號獨立表——新增保安員嗰陣（`!editingId`）
              個 guard 仲未存在，`POST .../staff-numbers` 用唔到，同牌照/
              PII/銀行分區一致做法，淨係編輯先顯示。雞頭（`isBroker`）
              可以見到（`GET .../staff-numbers` 跟「自己安員:view」，出廠
              有），但冇「新增編號」表單——「雞頭視角：chips 只讀，冇新增
              掣」（老闆決定原文）。 */}
          {editingId && (
            <>
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">員工編號</h3>
              {/* C（老闆 2026-09-19 拍板四條業務規則）：分區標題下加一句提示，
                  等用戶（尤其主管／會計）睇得明「邊個號用嚟做乜」，同「取消
                  咗嘅編號唔會復用」呢個關鍵行為。 */}
              <p className="text-xs text-zk-muted">
                更表／匯出一律顯示 U 號；MG 只作內部出糧／行政用；離職後編號取消，再入職會攞新編號。每個編號有自己嘅入職／離職日期。
              </p>
              {staffNumbers.filter((n) => n.status === "current").length === 0 ? (
                <div className="text-sm text-zk-muted">未有現用編號</div>
              ) : (
                <div className="space-y-1.5">{staffNumbers.filter((n) => n.status === "current").map(renderStaffNumberRow)}</div>
              )}

              {staffNumbers.filter((n) => n.status === "former").length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowFormerStaffNumbers((v) => !v)}
                    className="text-xs text-zk-primary underline"
                  >
                    {showFormerStaffNumbers ? "隱藏已取消嘅號" : `顯示已取消嘅號 ${staffNumbers.filter((n) => n.status === "former").length} 個`}
                  </button>
                  {showFormerStaffNumbers && (
                    <div className="mt-1.5 space-y-1.5">{staffNumbers.filter((n) => n.status === "former").map(renderStaffNumberRow)}</div>
                  )}
                </div>
              )}

              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={staffNumberError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="種類（scheme）">
                      <select
                        className={selectCls}
                        value={staffNumberForm.scheme}
                        onChange={(e) => setStaffNumberForm((f) => ({ ...f, scheme: e.target.value }))}
                      >
                        {KNOWN_STAFF_NUMBER_SCHEMES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                        <option value="其他">其他（自填）</option>
                      </select>
                    </Field>
                    {staffNumberForm.scheme === "其他" ? (
                      <Field label="自填 scheme">
                        <input
                          className={inputCls}
                          value={staffNumberForm.schemeOther}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, schemeOther: e.target.value }))}
                          placeholder="1-4 位英文字母"
                        />
                      </Field>
                    ) : (
                      <Field label="編號">
                        <input
                          className={inputCls}
                          value={staffNumberForm.number}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, number: e.target.value }))}
                          placeholder={`例：${staffNumberForm.scheme}00123`}
                        />
                      </Field>
                    )}
                  </div>
                  {staffNumberForm.scheme === "其他" && (
                    <div className="mt-2">
                      <Field label="編號">
                        <input
                          className={inputCls}
                          value={staffNumberForm.number}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, number: e.target.value }))}
                        />
                      </Field>
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {/* WP-MULTI：新增表單「生效日期」改「入職日期（呢個
                        號）」——同 renderStaffNumberRow／編輯表單一致講
                        法（見上面兩處同一段理由）。 */}
                    <Field label="入職日期（呢個號）（選填）">
                      <input
                        type="date"
                        className={inputCls}
                        value={staffNumberForm.valid_from}
                        onChange={(e) => setStaffNumberForm((f) => ({ ...f, valid_from: e.target.value }))}
                      />
                    </Field>
                    <Field label="備註（選填）">
                      <input className={inputCls} value={staffNumberForm.note} onChange={(e) => setStaffNumberForm((f) => ({ ...f, note: e.target.value }))} />
                    </Field>
                  </div>
                  <button
                    type="button"
                    disabled={staffNumberSaving || !staffNumberForm.number}
                    onClick={onAddStaffNumber}
                    className={`${btnSecondary} mt-2`}
                  >
                    {staffNumberSaving ? "新增緊…" : "新增編號"}
                  </button>
                </div>
              )}
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

              {/* WP-MULTI（老闆 2026-09-19 拍板，規劃師延伸同一原則）：
                  上面「地址」單一 input 照舊（快速改主要地址，經 PATCH
                  舊寫法），呢度加地址列表（可以多個，一個主要）。 */}
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">地址列表</h3>
              {addresses.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄地址</div>
              ) : (
                <div className="space-y-1.5">{addresses.map(renderAddressRow)}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={addressError} />
                  <Field label="新增地址">
                    <input className={inputCls} value={addressForm.address} onChange={(e) => setAddressForm((f) => ({ ...f, address: e.target.value }))} />
                  </Field>
                  <button type="button" disabled={addressSaving || !addressForm.address} onClick={onAddAddress} className={`${btnSecondary} mt-2`}>
                    {addressSaving ? "新增緊…" : "新增地址"}
                  </button>
                </div>
              )}

              {/* 上面「緊急聯絡人姓名／電話」兩個 input 照舊（快速改代表
                  行，經 PATCH 舊寫法），呢度加緊急聯絡人列表（可以多個，
                  可加／改／刪／排序）。 */}
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">緊急聯絡人列表</h3>
              <p className="text-xs text-zk-muted">排先個位（「代表」）會同步落上面嘅「緊急聯絡人姓名／電話」。</p>
              {contacts.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄緊急聯絡人</div>
              ) : (
                <div className="space-y-1.5">{contacts.map((c, i) => renderContactRow(c, i))}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={contactError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="姓名（新增聯絡人）">
                      <input className={inputCls} value={contactForm.name} onChange={(e) => setContactForm((f) => ({ ...f, name: e.target.value }))} />
                    </Field>
                    <Field label="電話（新增聯絡人）">
                      <input className={inputCls} value={contactForm.tel} onChange={(e) => setContactForm((f) => ({ ...f, tel: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label="關係（選填）" hint="例：配偶／父母／子女">
                    <input className={inputCls} value={contactForm.relationship} onChange={(e) => setContactForm((f) => ({ ...f, relationship: e.target.value }))} />
                  </Field>
                  <button
                    type="button"
                    disabled={contactSaving || (!contactForm.name && !contactForm.tel)}
                    onClick={onAddContact}
                    className={`${btnSecondary} mt-2`}
                  >
                    {contactSaving ? "新增緊…" : "新增緊急聯絡人"}
                  </button>
                </div>
              )}

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
            {/* Fable5.1（防資料被抹）：detail GET（PII/銀行嗰批 detail-only
                欄嘅真正來源）未完成之前 Save 一律 disabled——防止用戶用
                列表 row 起草嗰陣嘅空值（唔係真係「未填」，淨係列表 DTO
                冇呢批欄）撳「儲存」送 `|| null` 清走已有資料，見 openEdit()
                頂註解。 */}
            <button type="submit" disabled={saving || !detailLoaded} className={btnPrimary}>
              {!detailLoaded ? "載入中…" : saving ? "儲存緊…" : "儲存"}
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
