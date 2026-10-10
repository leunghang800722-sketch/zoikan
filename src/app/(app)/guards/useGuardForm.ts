// 保安員 Drawer 表單狀態／開關／儲存（P3-5.2：由 GuardsClient.tsx 原樣搬出，
// 行為零改變）。員工編號、電話／地址／緊急聯絡人、長工子資源各有獨立 hook
// （useGuardStaffNumbers／useGuardContacts／useGuardLongterm），在呢度組合。
// PII／銀行／出街價 field-group 嘅「送唔送」判斷（canUpdate*、detailAvailable）
// 原封不動。
"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/ui/api-client";
import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
import { emptyForm, type GuardRow } from "./guards-types";
import { useGuardContacts } from "./useGuardContacts";
import { useGuardLongterm } from "./useGuardLongterm";
import { useGuardStaffNumbers } from "./useGuardStaffNumbers";

export function useGuardForm({
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
  reloadList,
}: {
  isBroker: boolean;
  rows: GuardRow[];
  canUpdateSettlement: boolean;
  canUpdatePii: boolean;
  canUpdateBank: boolean;
  hasLicenceExtraField: boolean;
  setHasPiiField: (v: boolean) => void;
  setHasBankField: (v: boolean) => void;
  setHasLicenceExtraField: (v: boolean) => void;
  askConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  setNotice: (v: string | null) => void;
  reloadList: () => Promise<void>;
}) {
  // WP-BOSS5 §25.2：呢個保安員嘅介紹雞頭曾經俾 migration 清走（原本係
  // Y／internal_cash）——detail GET 先知，淨係編輯模式先有值。
  const [referralBrokerMigrationCleared, setReferralBrokerMigrationCleared] = useState(false);
  // 護照／特殊證件號：唔驗 check digit（API `allow_invalid_hkid`）。
  const [allowInvalidHkid, setAllowInvalidHkid] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // P3-4.3（H18）：Drawer 分 tab（基本／證件／聯絡／長工／銀行）；只係分組顯示，各區塊（連權限遮罩）一律照舊 mount。
  const [drawerTab, setDrawerTab] = useState<"basic" | "docs" | "contact" | "longterm" | "bank">("basic");
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

  // Opus 覆核（WP-MULTI 必修 5）：`tel`／`address`／`emergency_contact_
  // name`／`emergency_contact_tel` 呢幾個 legacy 欄記低「開抽屜嗰刻讀到
  // 嘅值」（`fillFormFromRow()` 度更新）——`onSubmit()` 淨係用戶真係改
  // 咗（同呢個 baseline 唔一樣）先夾落 body。就算後台（`applyLegacy
  // GuardContactPatch()`「值冇變就當冇改」）都有一層一樣嘅保護，前端呢
  // 度都唔送先係最穩陣（唔使靠 network round trip 先知道「其實冇改」，
  // 亦都避免用戶完全冇掂過電話呢個 field，純粹儲存第二個欄，都要拖埋
  // 一個（可能係髒值）`tel` 落 body）。
  const loadedLegacyContactRef = useRef({ tel: "", address: "", emergency_contact_name: "", emergency_contact_tel: "" });

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
      qas_issue_date: row.qas_issue_date ? row.qas_issue_date.slice(0, 10) : "",
      qas_expiry_date: row.qas_expiry_date ? row.qas_expiry_date.slice(0, 10) : "",
      hire_date: row.hire_date ? row.hire_date.slice(0, 10) : "",
      leave_date: row.leave_date ? row.leave_date.slice(0, 10) : "",
      bank_name: row.bank_name ?? "",
      bank_account_no: row.bank_account_no ?? "",
      bank_payee_name: row.bank_payee_name ?? "",
      bank_code: row.bank_code ?? "",
      blacklist_check_result: row.blacklist_check_result ?? "",
      blacklist_check_date: row.blacklist_check_date ? row.blacklist_check_date.slice(0, 10) : "",
      name_aliases: (row.name_aliases ?? []).join(", "),
      referral_broker_id: row.referral_broker_id ?? "",
      visa_sponsored_by_broker_id: row.visa_sponsored_by_broker_id ?? "",
    });
    // Opus 覆核（WP-MULTI 必修 5）：記低呢一刻讀到嘅 legacy 欄值做
    // baseline——`onSubmit()` 淨係用戶改咗（同呢個唔一樣）先送。
    // `fillFormFromRow()` 會 call 兩次（先用列表 row 起草，detail GET
    // 返嚟再 call 多次用真正詳情覆蓋，見 openEdit()）——兩次都更新呢個
    // baseline 係啱嘅：detail 嗰次先係真正權威值，用戶唔可能喺 detail
    // 未返嚟之前就打緊字（Save 掣喺 `detailLoaded` 之前一直 disabled）。
    loadedLegacyContactRef.current = {
      tel: row.tel ?? "",
      address: row.address ?? "",
      emergency_contact_name: row.emergency_contact_name ?? "",
      emergency_contact_tel: row.emergency_contact_tel ?? "",
    };
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

  const staffNos = useGuardStaffNumbers({ editingId, askConfirm, setNotice, reloadList, fillFormFromRow });
  const contactsH = useGuardContacts({ editingId, askConfirm, setNotice, reloadList, refreshMainFormAfterContactChange });
  // 轉長工成功之後重新打開（重新 GET）而家編輯緊嗰個保安員（`openEdit` 係下面嘅 function declaration，會 hoist）。
  const longterm = useGuardLongterm({
    editingId,
    setNotice,
    reloadList,
    reopenEditing: async () => {
      const row = rows.find((r) => r.id === editingId);
      if (row) await openEdit(row);
    },
  });

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setReferralBrokerMigrationCleared(false);
    staffNos.resetForCreate();
    contactsH.resetForCreate();
    longterm.resetForCreate();
    // 新增模式冇「loaded baseline」呢個概念（form 由空白開始）——重置做
    // 全空，等用戶打嘅任何非空值都算「改咗」，送得落 body（POST
    // /api/guards 本身接受 `tel`，同 PATCH 舊寫法唔同）。
    loadedLegacyContactRef.current = { tel: "", address: "", emergency_contact_name: "", emergency_contact_tel: "" };
    setDerivedSiaPermitType(null);
    setLegacyPermitInfo(null);
    // WP-MULTI：新增保安員嗰陣個 guard 仲未存在，三張新表分區同員工編號
    // 分區一致——淨係編輯先顯示，呢度重置返晒空。
    // WP-PHASE3：「長工」區同員工編號／電話等子資源一致——新增保安員
    // 嗰陣個 guard 仲未存在，淨係編輯先顯示，呢度重置返晒空。
    // 新增模式冇 detail GET 呢個問題（PII/銀行呢批欄新增表單本身都冇），
    // 兩個都直接 true——Save 掣唔應該因為呢個防護機制喺新增模式度 disabled。
    setDetailLoaded(true);
    setDetailAvailable(true);
    setDrawerTab("basic");
    setDrawerOpen(true);
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
    setReferralBrokerMigrationCleared(false);
    staffNos.resetForEdit();
    contactsH.resetForEdit();
    longterm.resetForEdit();
    // WP-MULTI：重置返三張新表分區嘅 inline 編輯／表單狀態（同上面
    // openCreate() 一致），實際資料靠下面 `contactsH.loadPhones()`／
    // `contactsH.loadAddresses()`／`contactsH.loadContacts()` 攞。
    // WP-PHASE3：重置「長工」區 inline 表單狀態（實際資料靠下面
    // `longterm.loadLongtermPosts()` 攞）。
    // Fable5.1（防資料被抹）：detail GET 呢個 request 未完成之前，Save
    // 掣要 disabled（見下面 JSX `disabled={saving || !detailLoaded}`）——
    // 列表 row 起草嘅 form，`date_of_birth`／`blacklist_check_date` 呢批
    // detail-only 欄一定係空字串，唔可以俾用戶喺呢段空窗期撳「儲存」將
    // 空字串當做「清空」送落 DB。
    setDetailLoaded(false);
    setDetailAvailable(false);
    setDrawerTab("basic");
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
      setReferralBrokerMigrationCleared(!!detailRes.data.referral_broker_migration_cleared);
      setDetailAvailable(true);
    } else {
      // Fable5.1：detail GET 失敗（包括 403 冇權睇、500）——`onSubmit()`
      // 唔會送任何 detail-only 欄（`detailAvailable` 保持 false），淨係
      // 送列表 DTO 本身有嘅欄，避免用錯（空）值清走 DB 已有資料。
      setDetailAvailable(false);
    }
    setDetailLoaded(true);
    await staffNos.loadStaffNumbers(row.id);
    await Promise.all([contactsH.loadPhones(row.id), contactsH.loadAddresses(row.id), contactsH.loadContacts(row.id), !isBroker ? longterm.loadLongtermPosts(row.id) : Promise.resolve()]);
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
      // Opus 覆核（WP-MULTI 必修 5）：淨係用戶真係改咗（同 openEdit()／
      // openCreate() 嗰刻嘅 baseline 唔一樣）先送——唔係就每次儲存（包括
      // 完全唔關電話事嘅編輯）都會拖埋呢個值落 body，撞正後台「值冇變
      // 就當冇改」嗰層都要額外做多一次正規化比較（見
      // src/app/api/guards/[id]/route.ts）；新增模式 baseline 一律空白
      // （openCreate() 已經重置），行為不變。
      tel: form.tel && form.tel !== loadedLegacyContactRef.current.tel ? form.tel : undefined,
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
    // （grants，「保安員個人資料/保安員銀行資料:update」）判斷，唔用
    // `hasPiiField`/`hasBankField`（view-based，「response 有冇呢粒
    // key」）——後者純粹決定分區顯唔顯示；有 view 冇 update 嘅角色
    // （理論上出廠矩陣兩個 action 一致開關，但自訂角色可以拆開）見到
    // 個 input 但冇權寫，唔應該連冇改嗰組欄都送落 body 觸發
    // assertFieldGroupWritable() 嘅 403。
    if (editingId) {
      if (canUpdatePii) {
        if (form.hkid) {
          body.hkid = form.hkid;
          if (allowInvalidHkid) body.allow_invalid_hkid = true;
        }
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
          // Opus 覆核（WP-MULTI 必修 5）：`address`／`emergency_contact_*`
          // 一樣淨係用戶真係改咗先送——同上面 `tel` 一致理由。
          if (form.address && form.address !== loadedLegacyContactRef.current.address) body.address = form.address;
          if (form.emergency_contact_name && form.emergency_contact_name !== loadedLegacyContactRef.current.emergency_contact_name) {
            body.emergency_contact_name = form.emergency_contact_name;
          }
          if (form.emergency_contact_tel && form.emergency_contact_tel !== loadedLegacyContactRef.current.emergency_contact_tel) {
            body.emergency_contact_tel = form.emergency_contact_tel;
          }
          if (form.blacklist_check_result) body.blacklist_check_result = form.blacklist_check_result;
          body.blacklist_check_date = form.blacklist_check_date || null;
          // WP-GUARD-FIX：逗號分隔拆返做陣列先送——同 sites/page.tsx
          // `aliases` 一致寫法。送埋（唔淨係改咗先送）都冇問題：route 層
          // `dropUnchangedFieldGroupValues()` 會自己判斷值冇變就跳過。
          body.name_aliases = form.name_aliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      if (canUpdateBank) {
        // Fable5.1：銀行三欄一樣 detail-only，同上同一個保護。
        if (detailAvailable) {
          if (form.bank_name) body.bank_name = form.bank_name;
          if (form.bank_account_no) body.bank_account_no = form.bank_account_no;
          if (form.bank_payee_name) body.bank_payee_name = form.bank_payee_name;
          // WP-BOSS5 §25.4：bank_code 淨係一個「建議下拉」揀出嚟嘅值
          // （見下面 JSX），會計都可以人手打；空字串照送（等清得走已填
          // 錯嘅值），`dropUnchangedFieldGroupValues()` 值冇變會自己跳過。
          if (form.bank_code) body.bank_code = form.bank_code;
        }
      }
      // 牌照/平安卡/入職離職日期跟現有「保安員」module，唔受 hasPiiField/
      // hasBankField 影響（有 `保安員:update` 就見得/改得到）；
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
        // WP-MISC（老闆 2026-09-20 拍板）：QAS 兩個日期欄一樣一律送
        // （`|| null`），同其餘日期欄一致（nullable schema，清得走）。
        body.qas_issue_date = form.qas_issue_date || null;
        body.qas_expiry_date = form.qas_expiry_date || null;
        body.hire_date = form.hire_date || null;
        body.leave_date = form.leave_date || null;
      }
      // WP-PHASE3（item 1）：長工介紹雞頭／簽證形式贊助雞頭——冇獨立
      // field-group，跟「保安員」module（同 employment_type 一致層級）；
      // `!isBroker` 純粹保守（呢兩個 input 本身淨係喺 `!isBroker` 先
      // render，呢度加多一層唔靠淨係 UI 冇 render 就保證唔送）。一律送
      // `|| null`（可以清空）。
      if (!isBroker) {
        body.referral_broker_id = form.referral_broker_id || null;
        body.visa_sponsored_by_broker_id = form.visa_sponsored_by_broker_id || null;
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
    await reloadList();
  }


  return {
    drawerOpen,
    setDrawerOpen,
    drawerTab,
    setDrawerTab,
    editingId,
    form,
    setForm,
    formError,
    saving,
    detailLoaded,
    referralBrokerMigrationCleared,
    allowInvalidHkid,
    setAllowInvalidHkid,
    derivedSiaPermitType,
    legacyPermitInfo,
    openCreate,
    openEdit,
    onSubmit,
    staffNos,
    contactsH,
    longterm,
    editingDrawerRef,
  };
}
export type GuardForm = ReturnType<typeof useGuardForm>;
