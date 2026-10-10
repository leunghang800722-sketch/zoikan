// 保安員名冊頁共用型別／常數（P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變）。
import { todayLocalStr } from "@/lib/ui/format";

export const EMPLOYMENT_TYPES = ["cash_casual", "longterm_autopay", "external", "casual_event"] as const;
export const BLACKLIST_RESULTS = ["clear", "flagged", "pending"] as const;
export const BLACKLIST_LABEL: Record<string, string> = { clear: "已核實、無案底", flagged: "有紀錄", pending: "審查緊" };
// WP-STAFFNO（老闆 2026-09-19 拍板）：已知嘅員工編號 scheme——U＝去
// Wilson 盤做散工必須有；MP＝去第二間公司嘅盤做散工用；MG＝轉咗長工；
// MW＝公司寫字樓員工編號（office staff，唔係前線保安；老闆 2026-09-19 確認）。UI 下拉用呢個列表＋「其他」（自填），
// 對應 API 嗰邊唔寫死 enum（zod regex 1-4 位大寫英文字母），將來加新
// 種類淨係改呢個陣列，唔使改 API。
export const KNOWN_STAFF_NUMBER_SCHEMES = ["U", "MP", "MG", "MW"] as const;

export interface GuardRow {
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
  // WP-STAFF-IMPORT B1：識別狀態（身份證＋電話），見 src/lib/guards/identity.ts。
  identity_status?: "complete" | "missing_hkid" | "missing_tel" | "missing_both";
  identity_review_fields?: string[];
  // WP-PII：新欄一律 optional——response 有冇呢粒 key 視乎 field-group
  // gate（冇「保安員個人資料/保安員銀行資料:view」成粒 key 都唔會出現，
  // 唔係值做 null），見 src/lib/api/field-groups.ts。
  hkid?: string | null;
  date_of_birth?: string | null;
  address?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_tel?: string | null;
  sia_permit_no?: string | null;
  // WP-STAFFNO：甲／乙類到期日分開存——跟現有「保安員」module（PATCH-only，
  // 同 sia_permit_no 一致層級）。
  sia_permit_a_expiry?: string | null;
  sia_permit_b_expiry?: string | null;
  safety_card_no?: string | null;
  safety_card_expiry?: string | null;
  // WP-MISC（老闆 2026-09-20 拍板）：QAS（基本保安訓練證書）——
  // `qas_issue_date`＝完成日期，`qas_expiry_date`＝到期日（如有）。
  qas_issue_date?: string | null;
  qas_expiry_date?: string | null;
  hire_date?: string | null;
  leave_date?: string | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_payee_name?: string | null;
  // WP-BOSS5 §25.4：3 位 HKICL 清算銀行編號，同上面三個 bank* 欄一組
  // detail-only。
  bank_code?: string | null;
  blacklist_check_result?: string | null;
  blacklist_check_date?: string | null;
  // WP-GUARD-FIX（老闆 2026-09-25 要求）：「更表用名（別名）」——同 hkid
  // 等其他 PII 新欄一致，response 有冇呢粒 key 視乎 field-group gate。
  name_aliases?: string[] | null;
  // WP-PHASE3（§20.4 Phase 3 item 1）：長工介紹雞頭／簽證形式贊助雞頭
  // ——雞頭 DTO（toBrokerGuardDTO）結構上冇呢兩欄，`optional` 純粹配合
  // 內部角色 DTO（呢兩欄本身冇 field-group，永遠有 key，唔係「冇權睇」
  // 嗰種 optional，但都寫 optional 保守兼容未來）。
  referral_broker_id?: string | null;
  visa_sponsored_by_broker_id?: string | null;
  // WP-BOSS5 §25.2：詳情 GET 先有（唔喺列表 DTO），淨係 detail response
  // 帶呢粒 key——true＝呢個保安員嘅 `referral_broker_id` 曾經俾 migration
  // 清走過（原本指住 Y／internal_cash，老闆決定 Y 唔可以做介紹雞頭）。
  referral_broker_migration_cleared?: boolean;
}
// WP-PHASE3（item 1）：保安員抽屜「長工」區——盤名下拉／崗位盤列表用。
export interface SiteRow {
  id: string;
  canonical_name: string;
}
// WP-PHASE3（item 1）：`GET/POST /api/guards/:id/longterm-posts` 一行。
export interface LongtermPostRow {
  id: string;
  site_id: string;
  effective_from: string;
  effective_to?: string | null;
  source: string;
  note?: string | null;
  voided_at?: string | null;
}
export interface BrokerRow {
  id: string;
  code: string;
  name: string;
  kind?: string;
}

// WP-BOSS5 §25.2（老闆 2026-09-28 決定 2）：介紹雞頭下拉剔走兩種內部結算
// 單位（B07＝internal_longterm／Y＝internal_cash）——佢哋唔係真正供應
// 長工嘅外部雞頭，唔可以揀做介紹雞頭。用 `kind` 判斷，唔寫死代號／id。
export const isInternalBrokerKind = (kind?: string) => kind === "internal_longterm" || kind === "internal_cash";
// WP-STAFFNO：`GET/POST /api/guards/:id/staff-numbers` 嘅一行。
export interface StaffNumberRow {
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
export interface PhoneRow {
  id: string;
  tel: string;
  label?: string | null;
  is_primary: boolean;
  note?: string | null;
}
export interface AddressRow {
  id: string;
  address: string;
  is_primary: boolean;
  note?: string | null;
}
export interface ContactRow {
  id: string;
  name?: string | null;
  tel?: string | null;
  relationship?: string | null;
  sort_order: number;
  note?: string | null;
}

export const emptyForm = {
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
  qas_issue_date: "",
  qas_expiry_date: "",
  hire_date: "",
  leave_date: "",
  bank_name: "",
  bank_account_no: "",
  bank_payee_name: "",
  bank_code: "",
  blacklist_check_result: "",
  blacklist_check_date: "",
  // WP-GUARD-FIX：逗號分隔字串（同 sites/page.tsx `aliases` 一致寫法），
  // onSubmit() 拆返做陣列先送。
  name_aliases: "",
  // WP-PHASE3（item 1）：長工介紹雞頭／簽證形式贊助雞頭——淨係編輯先會
  // 夾落 body（同 hkid 等 PATCH-only 欄一致），"" 代表未設。
  referral_broker_id: "",
  visa_sponsored_by_broker_id: "",
};

export const emptyLongtermPostForm = { site_id: "", effective_from: todayLocalStr(), note: "" };
// WP-PHASE3（item 2）：「轉長工」一步動作嘅獨立 mini-form（唔用主 form，
// 避免同編輯表單嘅 state 互相污染）。
export const emptyConvertForm = { site_id: "", effective_from: todayLocalStr(), referral_broker_id: "", monthly_salary: "" };

export const emptyStaffNumberForm = {
  scheme: KNOWN_STAFF_NUMBER_SCHEMES[0] as string,
  schemeOther: "",
  number: "",
  valid_from: "",
  note: "",
};

// WP-MULTI：三個新分區各自嘅「新增」表單初始值。
export const emptyPhoneForm = { tel: "", label: "", note: "" };
export const emptyAddressForm = { address: "", note: "" };
export const emptyContactForm = { name: "", tel: "", relationship: "", note: "" };
