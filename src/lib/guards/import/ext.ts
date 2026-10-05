// WP-STAFF-FIELDS 第二階段：導入包 v3 新欄（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）
// 嘅**唯讀評估**（preview、分診出題、projection 共用）＋標籤。寫入邏輯喺 ext-apply.ts（同一條 applyPerson 路徑）。
//
// 規則（老闆 2026-10-05 §30.3／30.5）：
//  - 新欄只寫 confirmed；只補空欄；現有值唔同 → conflict（唔覆蓋、出分診題）；review → 出分診題。
//  - ext key：`siaPermit.no`／`siaPermit.aExpiry`…／`safetyCard.*`／`qas.*`／`hireDate`／`bank`（四欄一個 unit）／
//    `emergency.1`／`emergency.2`（每位聯絡人一個 unit）／`staffHire.<工號>`（逐工號入職日期）。
//  - 權限：銀行 unit＝「安員銀行資料」；緊急聯絡人＝「安員個人資料」；其餘＝「安員」module。
import { normZh, normTel8, sameNameStrict } from "./text";
import { fieldValue, type FieldStatus, type PackagePerson } from "./package";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";

export type ExtDecision = "confirm" | "replace" | "skip";
export type ExtDecisions = Readonly<Record<string, ExtDecision>>;

export type ExtCheck = "new" | "fill" | "add" | "same" | "differs" | "taken" | "not_stored" | "hidden";
export type ExtOutcome = "written" | "same" | "conflict" | "skipped" | "not_confirmed" | "not_stored" | "not_written" | "held";

export interface ExtOutcomeRow {
  key: string;
  outcome: ExtOutcome;
}

/** 等人確認（唔自動寫）：identity＝身份未夠硬證據；bank＝銀行要身份證相同先自動寫；longterm＝長工糧讀 guards.hire_date */
export type ExtHeld = "identity" | "bank" | "longterm";

export interface ExtItem {
  key: string;
  status: FieldStatus;
  check: ExtCheck;
  held?: ExtHeld;
}

/**
 * 自動寫入閘（B1，Opus 驗收）：
 *  - typed_list_only_person：(a) DB 安員有身份證而且同名單完全相同 → 全部可寫（包括銀行）；
 *    (b) DB 冇身份證、中文姓名完全相同（sameNameStrict）→ 非銀行可寫，銀行出 bank_review；
 *    (c) 其他 → 新欄全部唔寫，出 ext_identity_check。
 *  - 有文件嘅人：銀行自動寫要求身份證相同（confirmed）；否則出 bank_review。
 *  - 冇「安員個人資料:view」嘅操作者：閘結果唔可以取決於現有身份證／姓名（否則變 oracle）→ typed 一律 (c)，銀行一律 hold。
 *  - 長工（longterm_autopay 或有長工合約）嘅人層面入職日期：長工糧讀 guards.hire_date
 *    （src/lib/longterm-payroll/aggregate.ts:334,440,477,513,548,593）→ 唔自動寫，出 ext_field_review。
 */
export interface ExtGate {
  scalars: boolean;
  bank: boolean;
  longtermHire: boolean;
}
export const OPEN_GATE: ExtGate = { scalars: true, bank: true, longtermHire: false };
export function extGateFor(args: { p: PackagePerson; guard: { hkid: string | null; nameZh: string; longterm: boolean } | null; hkidCanon: string | null; piiView: boolean }): ExtGate {
  const { p, guard, hkidCanon, piiView } = args;
  if (!guard) return OPEN_GATE;
  const typed = p.reasons.includes("typed_list_only_person");
  const longtermHire = guard.longterm;
  if (!piiView) return { scalars: !typed, bank: false, longtermHire };
  const hkidSame = !!hkidCanon && guard.hkid === hkidCanon;
  if (typed) {
    if (hkidSame) return { scalars: true, bank: true, longtermHire };
    if (!guard.hkid && sameNameStrict(guard.nameZh, fieldValue(p.nameZh))) return { scalars: true, bank: false, longtermHire };
    return { scalars: false, bank: false, longtermHire };
  }
  return { scalars: true, bank: hkidSame && p.hkid.status === "confirmed", longtermHire };
}
/** 呢個 key 喺閘之下係咪要 hold（冇人手決定先）。 */
export function heldBy(gate: ExtGate, key: string): ExtHeld | null {
  if (!gate.scalars) return "identity";
  if (key === "bank") return gate.bank ? null : "bank";
  if (key === "hireDate" && gate.longtermHire) return "longterm";
  return null;
}

export const PII_OVERWRITE_DENIED_MSG = "呢條要有安員個人資料修改權限嘅同事（例如老闆）答";
export const BANK_OVERWRITE_DENIED_MSG = "呢條要有安員銀行資料修改權限嘅同事答";
export const OVERWRITE_DENIED_MSGS: readonly string[] = [PII_OVERWRITE_DENIED_MSG, BANK_OVERWRITE_DENIED_MSG];

// ---------------------------------------------------------------------------
// 現有資料快照（apply.ts loadCtx 載入；日期一律 YYYY-MM-DD 字串）
// ---------------------------------------------------------------------------
export interface GuardExtSnap {
  siaPermitNo: string | null;
  siaPermitA: string | null;
  siaPermitB: string | null;
  safetyCardNo: string | null;
  safetyCardExpiry: string | null;
  qasIssue: string | null;
  qasExpiry: string | null;
  hire: string | null;
  bank: { code: string | null; name: string | null; accountNo: string | null; payee: string | null };
  /** 有效緊急聯絡人：子表有行就用子表；子表 0 行但 legacy 欄有值就當 1 位（寫入前會自癒搬入子表） */
  contacts: { name: string | null; tel: string | null }[];
  staffRows: { number: string; validFrom: string | null }[];
  /** 長工（employment_type=longterm_autopay 或有長工合約） */
  longterm: boolean;
}

export const EMPTY_BANK = { code: null, name: null, accountNo: null, payee: null } as const;

// ---------------------------------------------------------------------------
// 標籤
// ---------------------------------------------------------------------------
export const EXT_LABEL: Record<string, string> = {
  "siaPermit.no": "保安人員許可證號碼",
  "siaPermit.aExpiry": "許可證甲類屆滿日",
  "siaPermit.bExpiry": "許可證乙類屆滿日",
  "siaPermit.cExpiry": "許可證丙類屆滿日（系統未儲存）",
  "siaPermit.dExpiry": "許可證丁類屆滿日（系統未儲存）",
  "safetyCard.no": "平安咭號碼",
  "safetyCard.expiry": "平安咭屆滿日",
  "qas.issueDate": "QAS 簽發日",
  "qas.expiryDate": "QAS 屆滿日",
  hireDate: "入職日期",
  bank: "銀行資料",
  "emergency.1": "緊急聯絡人 1",
  "emergency.2": "緊急聯絡人 2",
  "emergency.3": "緊急聯絡人 3",
  "emergency.4": "緊急聯絡人 4",
  staffHire: "工號入職日期",
};
export function extLabel(key: string): string {
  if (key.startsWith("staffHire.")) return `${EXT_LABEL.staffHire}（${key.slice("staffHire.".length)}）`;
  return EXT_LABEL[key] ?? "其他資料";
}
export const EXT_CHECK_LABEL: Record<string, string> = {
  new: "新增",
  fill: "補空欄",
  same: "同現值一樣",
  differs: "同現值唔同",
  not_stored: "系統未儲存",
  hidden: "（冇權限睇比較）",
};
export const EXT_OUTCOME_LABEL: Record<string, string> = {
  written: "會寫入",
  same: "同現值一樣，唔郁",
  conflict: "同現值唔同，唔覆蓋",
  skipped: "略過",
  not_confirmed: "未確認，唔寫",
  not_stored: "系統未儲存",
  not_written: "冇寫入",
  held: "身份未夠證據／要人確認，未寫",
};

export const isBankKey = (k: string): boolean => k === "bank";
export const isEmergencyKey = (k: string): boolean => k.startsWith("emergency.");
/** 分診題目層：銀行＝重要層；其餘＝補充資料 */
export const extKeyGroup = (k: string): "bank" | "pii" | "guard" => (isBankKey(k) ? "bank" : isEmergencyKey(k) ? "pii" : "guard");

// ---------------------------------------------------------------------------
// 比較用正規化
// ---------------------------------------------------------------------------
export const normNo = (v: string | null | undefined): string => (v ?? "").toUpperCase().replace(/[\s-]/g, "");
export const normPayee = (v: string | null | undefined): string => (v ?? "").normalize("NFKC").toUpperCase().replace(/[\s,.·\-]+/g, " ").trim();
export const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");
const telKey = (v: string | null | undefined): string | null => (v ? normTel8(v) ?? (digits(v) || null) : null);
const nameKey = (v: string | null | undefined): string | null => (v ? (normZh(v) ?? v.trim().toUpperCase()) || null : null);

/** 同一個聯絡人嘅欄位值衝突：電話相同但姓名唔同，或姓名相同但電話唔同（唯一要出題嘅聯絡人情況）。 */
export function partialContact(a: { name: string | null; tel: string | null }, b: { name: string | null; tel: string | null }): boolean {
  if (sameContact(a, b)) return false;
  const tel = telKey(a.tel) !== null && telKey(a.tel) === telKey(b.tel);
  const name = nameKey(a.name) !== null && nameKey(a.name) === nameKey(b.name);
  return tel || name;
}

export function sameContact(a: { name: string | null; tel: string | null }, b: { name: string | null; tel: string | null }): boolean {
  return nameKey(a.name) === nameKey(b.name) && telKey(a.tel) === telKey(b.tel);
}

// ---------------------------------------------------------------------------
// 純量欄定義
// ---------------------------------------------------------------------------
export type ScalarCol = "siaPermitNo" | "siaPermitAExpiry" | "siaPermitBExpiry" | "safetyCardNo" | "safetyCardExpiry" | "qasIssueDate" | "qasExpiryDate" | "hireDate";
type Leaf = { value: string | null; status: FieldStatus } | undefined;
interface ScalarSpec {
  key: string;
  col: ScalarCol | null;
  kind: "no" | "date";
  get: (p: PackagePerson) => Leaf;
  cur: (s: GuardExtSnap) => string | null;
}
export const SCALARS: readonly ScalarSpec[] = [
  { key: "siaPermit.no", col: "siaPermitNo", kind: "no", get: (p) => p.siaPermit?.no, cur: (s) => s.siaPermitNo },
  { key: "siaPermit.aExpiry", col: "siaPermitAExpiry", kind: "date", get: (p) => p.siaPermit?.aExpiry, cur: (s) => s.siaPermitA },
  { key: "siaPermit.bExpiry", col: "siaPermitBExpiry", kind: "date", get: (p) => p.siaPermit?.bExpiry, cur: (s) => s.siaPermitB },
  { key: "siaPermit.cExpiry", col: null, kind: "date", get: (p) => p.siaPermit?.cExpiry, cur: () => null },
  { key: "siaPermit.dExpiry", col: null, kind: "date", get: (p) => p.siaPermit?.dExpiry, cur: () => null },
  { key: "safetyCard.no", col: "safetyCardNo", kind: "no", get: (p) => p.safetyCard?.no, cur: (s) => s.safetyCardNo },
  { key: "safetyCard.expiry", col: "safetyCardExpiry", kind: "date", get: (p) => p.safetyCard?.expiry, cur: (s) => s.safetyCardExpiry },
  { key: "qas.issueDate", col: "qasIssueDate", kind: "date", get: (p) => p.qas?.issueDate, cur: (s) => s.qasIssue },
  { key: "qas.expiryDate", col: "qasExpiryDate", kind: "date", get: (p) => p.qas?.expiryDate, cur: (s) => s.qasExpiry },
  { key: "hireDate", col: "hireDate", kind: "date", get: (p) => p.hireDate, cur: (s) => s.hire },
];
export const scalarEqual = (kind: "no" | "date", a: string | null, b: string | null): boolean => (kind === "no" ? normNo(a) === normNo(b) : a === b);

/** 包內有值嘅銀行欄（fieldValue 已處理 missing）。 */
export function bankLeaves(p: PackagePerson): { code: string | null; name: string | null; accountNo: string | null; payee: string | null; status: FieldStatus } | null {
  if (!p.bank) return null;
  const code = fieldValue(p.bank.code);
  const name = fieldValue(p.bank.name);
  const accountNo = fieldValue(p.bank.accountNo);
  const payee = fieldValue(p.bank.payeeName);
  if (!code && !name && !accountNo && !payee) return null;
  const sts = [p.bank.code, p.bank.name, p.bank.accountNo, p.bank.payeeName].filter((l) => fieldValue(l)).map((l) => l.status);
  return { code, name, accountNo, payee, status: sts.includes("review") ? "review" : "confirmed" };
}

export interface ContactIn {
  slot: 1 | 2 | 3 | 4;
  name: string | null;
  relationship: string | null;
  tel: string | null;
  status: FieldStatus;
  /** 人手決定（confirm／replace）時寫嘅完整值（包括 review 欄） */
  full: { name: string | null; relationship: string | null; tel: string | null };
}
/**
 * 每位聯絡人：name 或 tel 至少一個 confirmed → status confirmed，自動寫入只寫 confirmed 嘅欄（review 欄留空唔寫）；
 * 兩者都冇 confirmed → status review（出分診題，人手揀先寫完整值）。
 */
export function contactsOf(p: PackagePerson): ContactIn[] {
  const out: ContactIn[] = [];
  (p.emergencyContacts ?? []).forEach((c, i) => {
    const full = { name: fieldValue(c.name), relationship: fieldValue(c.relationship), tel: fieldValue(c.tel) };
    if (!full.name && !full.tel) return;
    const conf = (l: { value: string | null; status: FieldStatus }) => (l.status === "confirmed" ? fieldValue(l) : null);
    const cName = conf(c.name);
    const cTel = conf(c.tel);
    const slot = (i + 1) as 1 | 2 | 3 | 4;
    if (cName || cTel) out.push({ slot, name: cName, relationship: conf(c.relationship), tel: cTel, status: "confirmed", full });
    else out.push({ slot, ...full, status: "review", full });
  });
  return out;
}

export function staffHiresOf(p: PackagePerson): { number: string; value: string; status: FieldStatus }[] {
  const out: { number: string; value: string; status: FieldStatus }[] = [];
  for (const n of p.staffNumbers) {
    const v = n.hireDate ? fieldValue(n.hireDate) : null;
    if (v) out.push({ number: normalizeStaffNumber(n.number), value: v, status: n.hireDate!.status });
  }
  return out;
}

/**
 * 銀行 unit 同現有值比較。**全有或全無**：現有四欄全空先 `fill`（補空）；現有有任何一欄 → 只有
 * 「包內每個有值嘅欄（銀行名稱除外：名稱由編號推出，自由文字寫法可以唔同）同現有一致」先算 `same`，否則 `differs`。
 * 咁樣「補空」同「已有資料」之間冇中間狀態，冇銀行 view 嘅讀者估啱／估錯戶口都只會見到「冇寫入（已有資料）」。
 */
export function bankCompare(bank: NonNullable<ReturnType<typeof bankLeaves>>, cur: GuardExtSnap["bank"]): { state: "fill" | "same" | "differs"; anyCurrent: boolean } {
  const anyCurrent = !!(cur.code || cur.name || cur.accountNo || cur.payee);
  if (!anyCurrent) return { state: "fill", anyCurrent };
  const eq =
    (!bank.accountNo || (!!cur.accountNo && digits(bank.accountNo) === digits(cur.accountNo))) &&
    (!bank.code || (!!cur.code && bank.code.padStart(3, "0") === cur.code.padStart(3, "0"))) &&
    (!bank.payee || (!!cur.payee && normPayee(bank.payee) === normPayee(cur.payee)));
  return { state: eq ? "same" : "differs", anyCurrent };
}

/**
 * 唯讀評估：每個有值嘅新欄一行 { key, status(包內), check(對現有) }。
 * snap=null（新建／未對上現有安員）→ 有值嘅一律 `new`。
 */
export interface EvalOpts {
  gate?: ExtGate;
  /** 呢個戶口（銀行編號＋戶口數字）已被另一位安員使用 */
  bankTaken?: boolean;
  /** 工號 → 現時擁有者 guard id（逐工號入職日期預覽要同寫入一致：屬另一個人就唔會寫） */
  ownerOf?: (n: string) => string | null;
  guardId?: string | null;
}
export function evaluateExt(p: PackagePerson, snap: GuardExtSnap | null, opts: EvalOpts = {}): ExtItem[] {
  const gate = opts.gate ?? OPEN_GATE;
  return evaluateExtRaw(p, snap, opts).map((i) => {
    const held = i.key.startsWith("staffHire.") ? (gate.scalars ? null : "identity") : heldBy(gate, i.key);
    return held && i.check !== "not_stored" ? { ...i, held } : i;
  });
}
function evaluateExtRaw(p: PackagePerson, snap: GuardExtSnap | null, opts: EvalOpts): ExtItem[] {
  const out: ExtItem[] = [];
  for (const s of SCALARS) {
    const leaf = s.get(p);
    const v = leaf ? fieldValue(leaf) : null;
    if (!leaf || !v) continue;
    if (!s.col) {
      out.push({ key: s.key, status: leaf.status, check: "not_stored" });
      continue;
    }
    const cur = snap ? s.cur(snap) : null;
    out.push({ key: s.key, status: leaf.status, check: !snap ? "new" : !cur ? "fill" : scalarEqual(s.kind, cur, v) ? "same" : "differs" });
  }
  const bank = bankLeaves(p);
  if (bank) {
    if (opts.bankTaken) out.push({ key: "bank", status: bank.status, check: "taken" });
    else if (!snap) out.push({ key: "bank", status: bank.status, check: "new" });
    else out.push({ key: "bank", status: bank.status, check: bankCompare(bank, snap.bank).state });
  }
  for (const c of contactsOf(p)) {
    const key = `emergency.${c.slot}`;
    if (!snap) out.push({ key, status: c.status, check: "new" });
    else if (snap.contacts.some((x) => sameContact(x, c))) out.push({ key, status: c.status, check: "same" });
    else if (snap.contacts.some((x) => partialContact(x, c))) out.push({ key, status: c.status, check: "differs" });
    else out.push({ key, status: c.status, check: snap.contacts.length === 0 ? "fill" : "add" });
  }
  for (const h of staffHiresOf(p)) {
    const key = `staffHire.${h.number}`;
    const row = snap?.staffRows.find((r) => normalizeStaffNumber(r.number) === h.number);
    const owner = !row ? (opts.ownerOf?.(h.number) ?? null) : null;
    if (owner && owner !== opts.guardId) {
      out.push({ key, status: h.status, check: "not_stored" }); // 工號屬另一個人：唔會寫
      continue;
    }
    out.push({ key, status: h.status, check: !snap || !row ? "new" : !row.validFrom ? "fill" : row.validFrom === h.value ? "same" : "differs" });
  }
  return out;
}

/** 給冇權限讀現有值嘅讀者：同現有值比較嘅結果（same／differs）一律 hidden；fill／new 唔洩露比較，保留。 */
export function maskExtChecks(items: readonly ExtItem[], opts: { pii: boolean; bank: boolean }): ExtItem[] {
  return items.map((i) => {
    const hide = isBankKey(i.key) ? !opts.bank : isEmergencyKey(i.key) ? !opts.pii : false;
    return hide && (i.check === "same" || i.check === "differs" || i.check === "add" || i.check === "taken") ? { ...i, check: "hidden" } : i;
  });
}

/** 依 key 分組統計用（staffHire.<工號> → staffHire）。 */
export const extStatKey = (k: string): string => (k.startsWith("staffHire.") ? "staffHire" : k);

// 注意：response 經 brandSafeResponse 會將物件 key 轉 snake_case，所以動態 key（ext key）一律用陣列 [{key,…}] 輸出，唔用 record。
export interface ExtAggregate {
  /** 包內狀態統計（唔依賴現有值） */
  fields: { key: string; confirmed: number; review: number }[];
  /** 自動套用會補／新增嘅欄數（check fill／new 且包內 confirmed） */
  to_write: { key: string; count: number }[];
  /** confirmed 但同現有唔同（會出衝突題）；冇權限讀現值嘅讀者一律 0（hidden 唔計） */
  conflicts: number;
  /** 等人確認（唔自動寫）嘅 confirmed 欄數 */
  held: number;
}
/** 單一彙總函數：preview（有權限）同 projection（遮罩後）都由 rows 重新計，唔直接用未遮罩資料。 */
export function aggregateExt(rowItems: readonly (readonly ExtItem[])[]): ExtAggregate {
  const fields: Record<string, { confirmed: number; review: number }> = {};
  const toWrite: Record<string, number> = {};
  let conflicts = 0;
  let held = 0;
  for (const items of rowItems) {
    for (const i of items) {
      const k = extStatKey(i.key);
      if (i.held && i.status === "confirmed") held += 1;
      const f = (fields[k] ??= { confirmed: 0, review: 0 });
      if (i.status === "confirmed") f.confirmed += 1;
      else if (i.status === "review") f.review += 1;
      if (i.status === "confirmed" && !i.held && (i.check === "fill" || i.check === "new" || i.check === "add")) toWrite[k] = (toWrite[k] ?? 0) + 1;
      if (i.status === "confirmed" && (i.check === "differs" || i.check === "taken")) conflicts += 1;
    }
  }
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  return {
    fields: Object.entries(fields).map(([key, v]) => ({ key, ...v })).sort(byKey),
    to_write: Object.entries(toWrite).map(([key, count]) => ({ key, count })).sort(byKey),
    conflicts,
    held,
  };
}
