// Opus 對抗式驗收 M1/M2/M3/P4：收客價／出街價 field-level gate 嘅**中央**
// 定義——唔准逐 route 各自補（之前 `rbac/field-gates.ts` 淨係管
// rate_cards/special_items 兩個資源、掛漏 sites/shift_records/
// month_closes，同一個概念散落幾個 route 自己判斷，容易漏）。
//
// 呢個檔案淨係做「邊個資源嘅邊啲欄屬於邊個 field group」呢個**資料**
// 定義；`applyFieldGroupGate()`／`assertFieldGroupWritable()` 兩個函數
// 係**唯一**執行入口，全部 route 一律經呢兩個，唔准自己再寫一次
// `delete data.clientRate` 呢類散裝邏輯。
//
// key 用 **snake_case**（同 request/response body 嘅 wire format 一致，
// 見 src/lib/api/schemas.ts／src/lib/api/dto/）。
import type { Module } from "../rbac/matrix";
import type { AuthedSession } from "../rbac/requirePermission";
import { hasPermission } from "../rbac/requirePermission";
import { Forbidden } from "./errors";
import { brandSafeResponse, type Dto } from "./serialize";

export const CLIENT_RATE_FIELDS = {
  shift_records: ["client_rate_snapshot"],
  rate_cards: ["client_rate"],
  sites: ["monthly_fee"],
  special_items: ["revenue"],
  // month_closes 而家嘅 schema 仲未有營業額/毛利呢類聚合欄（呢啲喺
  // WP3/WP4 先會加落 site_monthly_summary 呢類報表 view）——呢度預留
  // 空陣列，等嗰陣加返欄嗰陣順手加落嚟就得，唔使改呢個機制本身。
  month_closes: [],
  // C2（Opus 對抗式驗收第四輪）：guards/brokers 冇「收客價」相關欄。
  guards: [],
  brokers: [],
  // P1-WP3（E）：referral_fee_rates 冇「收客價」性質嘅欄（呢個表淨係
  // 記公司俾雞頭嘅介紹費，唔係收客嗰邊）。
  referral_fee_rates: [],
  // WP-MULTI（老闆 2026-09-19 拍板）：電話／緊急聯絡人／地址三張新表——
  // 加落嚟純粹俾 `AUDIT_FIELD_GROUP_RESOURCE_BY_TABLE`（audit-log route
  // 讀出嗰陣，見 src/app/api/audit-log/route.ts）用，先可以將呢三張表
  // 嘅 audit_log before/after 一齊經 `applyFieldGroupGate()` 過返（同
  // guards resource 一致模型：「寫入時存完整 DTO，讀出時先按讀者權限再
  // gate」，唔可以淨係得 guards 表本身受保護、佢哋自己嘅獨立審計記錄漏
  // 咗）。呢三張表冇「收客價」性質嘅欄。
  guard_phones: [],
  guard_emergency_contacts: [],
  guard_addresses: [],
  // WP-ROSTER-UPLOAD Phase A：冇「收客價」性質嘅欄。
  roster_uploads: [],
  roster_upload_rows: [],
} as const;

export const SETTLEMENT_FIELDS = {
  shift_records: [
    "guard_wage_snapshot",
    "broker_fee_snapshot",
    "rescue_rate",
    "referral_fee_snapshot",
    "settlement_page",
    "source",
    "provenance",
  ],
  // C2（Opus 對抗式驗收第四輪）：payout_rate（出街價｜俾雞頭嘅單價）之前
  // 漏咗喺呢個 list，冇出街價:view 都見到。
  rate_cards: ["guard_wage", "broker_fee", "payout_rate", "source", "evidence", "note"],
  sites: [],
  // C2：cost 係盤級支出（出街價性質嘅金錢），之前漏咗。
  special_items: ["cost"],
  month_closes: [],
  // C2：guards.monthly_salary（長工月薪，出街價性質嘅人力成本）、
  // brokers.bank_info（雞頭銀行戶口）之前完全冇經呢個機制——GET guards／
  // GET brokers 嘅內部角色 DTO（toGuardFullDTO／toBrokerFullDTO）冇
  // 出街價:view 都會見到成個 monthly_salary／bank_info。
  guards: ["monthly_salary"],
  brokers: ["bank_info"],
  // P1-WP3（E）：fee_per_shift 係公司出俾雞頭嘅成本（「出街價」性質）——
  // 內部角色冇「出街價:view」（例如會計出廠已經有，但自訂角色可以關）
  // 就見唔到呢粒數。雞頭自己睇自己嘅費率唔經呢個機制（見 broker-dto.ts
  // 註解），一向准。
  referral_fee_rates: ["fee_per_shift"],
  // WP-MULTI：冇「出街價」性質嘅欄。
  guard_phones: [],
  guard_emergency_contacts: [],
  guard_addresses: [],
  // WP-ROSTER-UPLOAD Phase A：冇「出街價」性質嘅欄（settlement_broker_id
  // 係配對結果唔係金錢，唔屬於呢個 field group）。
  roster_uploads: [],
  roster_upload_rows: [],
} as const;

// WP-PII（老闆 2026-09-17 拍板）：保安員「安員個人資料」／「安員銀行
// 資料」field group——同 CLIENT_RATE_FIELDS/SETTLEMENT_FIELDS 一樣嘅
// 「逐 resource key，其餘 resource 留空陣列」形狀（淨係 guards 有嘢），
// 咁樣可以直接掛落 applyFieldGroupGate()／assertFieldGroupWritable() 同一
// 個機制，唔使逐 route 另外寫一次「有冇呢個 module:view 就剝呢幾隻欄」
// 嘅邏輯。牌照（sia_permit_no/type/expiry）、平安卡、入職/離職日期
// 刻意唔喺呢兩個 field group——跟現有「安員」module（主管出廠已經
// 有 安員:view/update，即老闆話嘅「主管睇部分」），唔需要額外 field-
// level gate，直接留喺 GUARD_FIELDS 白名單（src/lib/api/dto/index.ts）。
export const GUARD_PII_FIELDS = {
  shift_records: [],
  rate_cards: [],
  sites: [],
  special_items: [],
  month_closes: [],
  // WP-GUARD-FIX（老闆 2026-09-25 要求）：`name_aliases`（更表用名／別名）
  // 加入呢組——同 hkid 等 PII 欄一致敏感度（可以間接曝露曾用名/花名）。
  guards: ["hkid", "date_of_birth", "address", "emergency_contact_name", "emergency_contact_tel", "blacklist_check_result", "blacklist_check_date", "name_aliases"],
  brokers: [],
  referral_fee_rates: [],
  // WP-MULTI：`guard_emergency_contacts`／`guard_addresses` 呢兩張表
  // 本身成個 resource 就係 PII 性質（同「安員個人資料」module 一致敏感
  // 度）——`AUDIT_FIELD_GROUP_RESOURCE_BY_TABLE` 讀出嗰陣用嘅係呢兩個
  // resource 自己嘅欄名（`name`/`tel`/`relationship`／`address`，唔係
  // `guards` resource 嗰個 `emergency_contact_name`/`emergency_contact_
  // tel`／`address`），所以呢度要獨立一份、唔可以借 `guards` 嗰份（借
  // 咗會因為欄名對唔上而形同冇 gate）。`guard_phones` 跟「安員」
  // module（同 `tel` 喺 guards resource 一直唔喺 PII 組一致），留空。
  guard_phones: [],
  guard_emergency_contacts: ["name", "tel", "relationship", "note"],
  guard_addresses: ["address", "note"],
  // WP-ROSTER-UPLOAD Phase A（§15.3）：`roster_upload_rows` 嘅
  // `name_raw`／`tel_raw`／`staff_no_raw`——更表檔案逐行原文姓名／電話／
  // 工號（可能未配對成功嘅人），同「安員個人資料」一致敏感度。冇
  // 「安員個人資料:view」嘅內部角色（例如關咗呢格嘅主管）就算有「更表
  // 上載:view」都見唔到呢三隻欄，`code_raw`／`work_date`／配對結果等
  // 唔屬於 PII 嘅欄唔受影響。`roster_uploads` 本身（月份/盤/檔名/版本）
  // 冇逐行 PII，留空。
  roster_uploads: [],
  roster_upload_rows: ["name_raw", "tel_raw", "staff_no_raw"],
} as const satisfies Record<keyof typeof CLIENT_RATE_FIELDS, readonly string[]>;

export const GUARD_BANK_FIELDS = {
  shift_records: [],
  rate_cards: [],
  sites: [],
  special_items: [],
  month_closes: [],
  // WP-BOSS5 §25.4：bank_code（3 位 HKICL 清算編號）同一組。
  guards: ["bank_name", "bank_account_no", "bank_payee_name", "bank_code"],
  brokers: [],
  referral_fee_rates: [],
  // WP-MULTI：冇銀行類欄。
  guard_phones: [],
  guard_emergency_contacts: [],
  guard_addresses: [],
  // WP-ROSTER-UPLOAD Phase A：冇銀行類欄。
  roster_uploads: [],
  roster_upload_rows: [],
} as const satisfies Record<keyof typeof CLIENT_RATE_FIELDS, readonly string[]>;

export type FieldGroupResource = keyof typeof CLIENT_RATE_FIELDS;

function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  if (!keys.length) return obj;
  const clone: Record<string, unknown> = { ...obj };
  for (const k of keys) delete clone[k];
  return clone as T;
}

/** 讀：冇「收客價:view」剝 CLIENT_RATE_FIELDS；冇「出街價:view」剝
 * SETTLEMENT_FIELDS 入面嘅價錢/來源欄。全部角色（包括老闆/主管/會計）
 * 一視同仁經呢個 gate——冇任何角色可以繞過（老闆出廠矩陣兩個 module
 * 都係 grant，所以老闆實際上乜都睇到，但路徑一致，唔靠「老闆特殊處理」）。 */
export async function applyFieldGroupGate<T extends Record<string, unknown>>(
  session: AuthedSession,
  resource: FieldGroupResource,
  row: T,
): Promise<T> {
  let out = row;
  const clientFields = CLIENT_RATE_FIELDS[resource];
  if (clientFields.length && !(await hasPermission(session, "收客價", "view"))) {
    out = omit(out, clientFields);
  }
  const settlementFields = SETTLEMENT_FIELDS[resource];
  if (settlementFields.length && !(await hasPermission(session, "出街價", "view"))) {
    out = omit(out, settlementFields);
  }
  const guardPiiFields = GUARD_PII_FIELDS[resource];
  if (guardPiiFields.length && !(await hasPermission(session, "安員個人資料", "view"))) {
    out = omit(out, guardPiiFields);
  }
  const guardBankFields = GUARD_BANK_FIELDS[resource];
  if (guardBankFields.length && !(await hasPermission(session, "安員銀行資料", "view"))) {
    out = omit(out, guardBankFields);
  }
  return out;
}

export async function applyFieldGroupGateToList<T extends Record<string, unknown>>(
  session: AuthedSession,
  resource: FieldGroupResource,
  list: { rows: T[]; total: number; skip: number; take: number },
): Promise<Dto<{ rows: T[]; total: number; skip: number; take: number }>> {
  const rows = await Promise.all(list.rows.map((r) => applyFieldGroupGate(session, resource, r)));
  return brandSafeResponse({ ...list, rows });
}

// WP-PII（Opus 驗收必修 2a）：「主管/會計改保安員 403 回歸」——前端編輯
// 抽屜開嗰陣用列表/詳情嘅現有值起草成個 form（見 GuardsClient.tsx
// `fillFormFromRow()`），撳「儲存」淨係改咗其中幾隻欄，但 form 冚唪唥
// 值一齊送落 body。`assertFieldGroupWritable()` 見到 body 帶住
// `monthly_salary`（就算值同而家 DB 一樣）就當「想寫」，冇「出街價:
// update」就 403——連淨係改電話呢類冇 field-group 保護嘅欄都一齊被拒。
//
// 修法：PATCH route 入面、`assertFieldGroupWritable()` 之前，先用呢個
// 函數同 `before`（改動之前嘅 Prisma row，camelCase）比對——field-group
// 受控嘅欄如果值冇變，就當「冇寫」，由 body 度刪走（唔會再觸發嗰個
// field-group 嘅 403，亦都唔會落 Prisma update data，減少無謂寫入）。
// 真係想改嗰粒數（值唔同）先會保留喺 body，交返 assertFieldGroupWritable()
// 照正常權限判斷 403。
//
// 型別正規化（`isSameFieldGroupValue()`）要處理幾種唔對稱：
//  - money（`z.union([z.number(), z.string()])`）body 值 vs Prisma
//    Decimal——Decimal.toString() 保留 DB 精度（例如 "8000.00"），body
//    可能係 8000（number）；純字串比對會假陽性判「唔同」。
//  - dateOnly（`z.coerce.date()`）body 值 vs Prisma Date——淨係比日期
//    部分（dateOnly 冇時間），時區/毫秒噪音唔應該當「改咗」。
//  - hkid/其他字串欄——直接字串比。
//  - ""/null/undefined 一律當「冇值」，等空字串同 null 唔會誤判做改咗
//    （PATCH schema 呢批新欄係 optional 唔係 nullable，前端「唔填」送
//    ""，唔會出現喺呢個函數——但保險起見一致處理）。
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

function normalizeFieldGroupValue(v: unknown, numeric: boolean): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = typeof v === "string" ? v : String(v);
  const trimmed = s.trim();
  // Opus 覆核 S1：數字正規化（"8000.00" ≡ 8000）只可以用喺金額類欄（Decimal
  // vs number 唔對稱）；戶口號碼／電話呢類「數字字串」要逐字相等——
  // "000123456" 同 "123456" 係兩個唔同戶口，唔可以被 Number() 撞埋。
  if (numeric && NUMERIC_STRING_RE.test(trimmed)) return String(Number(trimmed));
  return trimmed;
}

function isSameFieldGroupValue(a: unknown, b: unknown, numeric: boolean): boolean {
  return normalizeFieldGroupValue(a, numeric) === normalizeFieldGroupValue(b, numeric);
}

/** 喺 `assertFieldGroupWritable()` 之前行，剝走 body 入面「field-group 受控、
 * 但值同 `before` 一樣」嘅欄，令前端帶返原值唔會被誤 403。`before` 用
 * camelCase Prisma row；`body` 用 snake_case。回傳新 object。
 *
 * Opus 覆核 M1：呢個「值冇變就當冇改」只可以喺 session **有嗰組嘅 view 權**
 * 先做——否則回應碼會變成 oracle（猜啱 200／猜錯 403），冇 view 權嘅主管可以
 * 憑 PATCH 回應核實身份證、甚至枚舉月薪。有 view 權嘅人本身睇得到個值。 */
export async function dropUnchangedFieldGroupValues<T extends Record<string, unknown>>(
  session: AuthedSession,
  resource: FieldGroupResource,
  body: T,
  before: Record<string, unknown>,
): Promise<T> {
  const groups: Array<{ keys: readonly string[]; module: Module; numeric: boolean }> = [
    { keys: CLIENT_RATE_FIELDS[resource], module: "收客價", numeric: true },
    { keys: SETTLEMENT_FIELDS[resource], module: "出街價", numeric: true },
    { keys: GUARD_PII_FIELDS[resource], module: "安員個人資料", numeric: false },
    { keys: GUARD_BANK_FIELDS[resource], module: "安員銀行資料", numeric: false },
  ];
  const out: Record<string, unknown> = { ...body };
  for (const g of groups) {
    const present = g.keys.filter((k) => k in out);
    if (!present.length) continue;
    if (!(await hasPermission(session, g.module, "view"))) continue; // 冇 view 權：唔剝，交俾 assertFieldGroupWritable 一律 403
    for (const snakeKey of present) {
      const camelKey = snakeKey.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      if (isSameFieldGroupValue(out[snakeKey], before[camelKey], g.numeric)) delete out[snakeKey];
    }
  }
  return out as T;
}

/** 寫：parseBody() 之後，create/update 落 Prisma 之前一律經呢個。body
 * 用 snake_case（同 schemas.ts 嘅 parse 輸出一致）。 */
export async function assertFieldGroupWritable(
  session: AuthedSession,
  resource: FieldGroupResource,
  body: Record<string, unknown>,
): Promise<void> {
  const clientFields = CLIENT_RATE_FIELDS[resource].filter((f) => f in body);
  if (clientFields.length && !(await hasPermission(session, "收客價", "update"))) {
    throw Forbidden(`冇「收客價」寫入權限，唔可以改 ${clientFields.join("/")}`);
  }
  const settlementFields = SETTLEMENT_FIELDS[resource].filter((f) => f in body);
  if (settlementFields.length && !(await hasPermission(session, "出街價", "update"))) {
    throw Forbidden(`冇「出街價」寫入權限，唔可以改 ${settlementFields.join("/")}`);
  }
  const guardPiiFields = GUARD_PII_FIELDS[resource].filter((f) => f in body);
  if (guardPiiFields.length && !(await hasPermission(session, "安員個人資料", "update"))) {
    throw Forbidden(`冇「安員個人資料」寫入權限，唔可以改 ${guardPiiFields.join("/")}`);
  }
  const guardBankFields = GUARD_BANK_FIELDS[resource].filter((f) => f in body);
  if (guardBankFields.length && !(await hasPermission(session, "安員銀行資料", "update"))) {
    throw Forbidden(`冇「安員銀行資料」寫入權限，唔可以改 ${guardBankFields.join("/")}`);
  }
}
