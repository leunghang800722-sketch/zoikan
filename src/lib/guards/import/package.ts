// WP-STAFF-IMPORT B3：導入包格式（JSON，淨文字）＋ zod 驗證＋包內跨人衝突偵測。
//
// 導入包係本機（Stage A）產生嘅 `data/2026-10/staff-import/out/import-package.json`
// （`scripts/staff-import/06-build-package.ts`）。**唔帶 guard id**——伺服器對自己個 DB 對齊。
// 逐欄狀態（Opus 抽樣後定案）：status ∈ confirmed／review／missing；只有 confirmed 嘅欄先會
// 自動寫入，review 欄要喺覆核頁逐欄確認。
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalHkid } from "@/lib/guards/identity";
import { normTel8 } from "./text";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { HKICL_BANK_CODE_SET } from "@/lib/longterm-payroll/hkicl-bank-codes";

const FIELD_STATUSES = ["confirmed", "review", "missing"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export type PersonField = "hkid" | "nameZh" | "nameEn" | "dateOfBirth" | "sex" | "phone" | "address";

const fieldSchema = z.object({ value: z.string().max(500).nullable(), status: z.enum(FIELD_STATUSES) }).strict();

/** 地址來源：住址證明（預設，舊包冇 source 當呢個）／申請表（冇住址證明嘅人，老闆 2026-10-03 決定）。 */
const ADDRESS_SOURCES = ["address_proof", "application_form"] as const;
export type AddressSource = (typeof ADDRESS_SOURCES)[number];
const addressFieldSchema = z
  .object({ value: z.string().max(500).nullable(), status: z.enum(FIELD_STATUSES), source: z.enum(ADDRESS_SOURCES).optional() })
  .strict();

export function addressSourceOf(a: { source?: AddressSource }): AddressSource {
  return a.source ?? "address_proof";
}

// ---------------------------------------------------------------------------
// WP-STAFF-FIELDS 第二階段：導入包 v3 新欄（全部可選；每個 leaf 都係 {value,status}，值要通過嚴格格式驗證）
// ---------------------------------------------------------------------------
function isIsoCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
/** 香港時區嘅「今日」（UTC+8），避免香港凌晨 0–8 點驗證日期上限差一日 */
const todayIso = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
/** 屆滿日 2015–2040（同第一階段 expiryInRange 一致）；簽發日 2000–今日；入職日 1990–今日。 */
const dateInRange = (kind: "expiry" | "issue" | "hire") => (v: string): boolean => {
  if (!isIsoCalendarDate(v)) return false;
  if (kind === "expiry") return v >= "2015-01-01" && v <= "2040-12-31";
  if (kind === "issue") return v >= "2000-01-01" && v <= todayIso();
  return v >= "1990-01-01" && v <= todayIso();
};
const PERMIT_NO_RE = /^[A-Z]{1,2}-\d{6}-[0-9A](-\d{3})?$/;
const SAFETY_CARD_NO_RE = /^[A-Z0-9-]{4,24}$/;
const HK_TEL8_RE = /^[2-9]\d{7}$/;
const BANK_ACCT_RE = /^\d{6,20}$/;

const leaf = (ok: (v: string) => boolean, max = 200) =>
  z
    .object({ value: z.string().max(max).nullable(), status: z.enum(FIELD_STATUSES) })
    .strict()
    .refine((f) => f.value === null || f.value === "" || ok(f.value), { message: "invalid_value" });
const textLeaf = (max: number) => leaf((v) => v.trim().length > 0 && v.trim() === v, max);

const permitNoLeaf = leaf((v) => PERMIT_NO_RE.test(v), 24);
const expiryLeaf = leaf(dateInRange("expiry"), 10);
const issueLeaf = leaf(dateInRange("issue"), 10);
const hireLeaf = leaf(dateInRange("hire"), 10);
const telLeaf = leaf((v) => HK_TEL8_RE.test(v), 8);

const siaPermitSchema = z
  .object({ no: permitNoLeaf, aExpiry: expiryLeaf, bExpiry: expiryLeaf, cExpiry: expiryLeaf.optional(), dExpiry: expiryLeaf.optional() })
  .strict();
const safetyCardSchema = z.object({ no: leaf((v) => SAFETY_CARD_NO_RE.test(v), 24), expiry: expiryLeaf }).strict();
const qasSchema = z.object({ issueDate: issueLeaf, expiryDate: expiryLeaf }).strict();
const bankSchema = z
  .object({
    code: leaf((v) => HKICL_BANK_CODE_SET.has(v), 3),
    name: textLeaf(60),
    accountNo: leaf((v) => BANK_ACCT_RE.test(v), 20),
    payeeName: textLeaf(100),
  })
  .strict();
const emergencyContactSchema = z.object({ name: textLeaf(50), relationship: textLeaf(30), tel: telLeaf }).strict();

export const unassignedBankAccountSchema = z
  .object({
    key: z.string().min(1).max(64),
    bankCode: z.string().refine((v) => HKICL_BANK_CODE_SET.has(v), { message: "invalid_value" }),
    accountNo: z.string().regex(BANK_ACCT_RE),
    payeeName: z.string().trim().min(1).max(100),
  })
  .strict();
export type UnassignedBankAccount = z.infer<typeof unassignedBankAccountSchema>;

const staffNumberV2 = z.object({ scheme: z.string().min(1).max(8), number: z.string().min(1).max(32) }).strict();
const staffNumberV3 = z.object({ scheme: z.string().min(1).max(8), number: z.string().min(1).max(32), hireDate: hireLeaf.optional() }).strict();

const personHead = {
  key: z.string().min(1).max(64),
  hkid: fieldSchema,
  nameZh: fieldSchema,
  nameEn: fieldSchema,
  dateOfBirth: fieldSchema,
  sex: fieldSchema,
  phone: fieldSchema,
  address: addressFieldSchema,
};
const personTail = {
  rating: z.enum(["auto_ok", "review", "fail"]),
  reasons: z.array(z.string().max(80)).max(60),
  /** 包內群組層面衝突理由（例如同 hkid 不同檔中文名差異大）；有就一律 conflict。 */
  conflicts: z.array(z.string().max(80)).max(20).optional(),
  /** TE-7：呢個人嘅來源文件資訊（頁數／各類頁數／檔案類型；冇 PII），分診題卡「冇讀到任何資料」時顯示 */
  docInfo: z
    .object({
      pageCount: z.number().int().min(0).max(2000),
      pagesByKind: z.record(z.string().max(30), z.number().int().min(0).max(2000)),
      fileExts: z.array(z.string().max(8)).max(5).optional(),
    })
    .strict()
    .optional(),
};

// 欄位次序刻意同 v2 一致（hashPackage 用 JSON.stringify，key 次序即 hash）。
const packagePersonSchemaV2 = z.object({ ...personHead, staffNumbers: z.array(staffNumberV2).max(20), ...personTail }).strict();
export const packagePersonSchema = z
  .object({
    ...personHead,
    staffNumbers: z.array(staffNumberV3).max(20),
    ...personTail,
    /** v3：牌照／平安咭／QAS／銀行／緊急聯絡人／入職日期（全部可選；只有 confirmed 先自動寫入，且只補空欄） */
    siaPermit: siaPermitSchema.optional(),
    safetyCard: safetyCardSchema.optional(),
    qas: qasSchema.optional(),
    bank: bankSchema.optional(),
    emergencyContacts: z.array(emergencyContactSchema).max(4).optional(),
    /** 人層面入職日期（取最早）；逐工號入職日期放喺 staffNumbers[].hireDate */
    hireDate: hireLeaf.optional(),
    /** TE-13：打字名單（U Team／在勤兼職）逐工號嘅身份證號（canonical）——只畀 ghost 自動併入規則核對「名單 HKID 係咪同真人一致」，唔寫入任何資料 */
    listHkids: z.record(z.string().max(32), z.string().max(12)).optional(),
  })
  .strict();

const packageHead = { generatedAt: z.string().max(40), source: z.enum(["single_ocr"]).optional() };

const importPackageSchemaV2 = z.object({ version: z.literal(2), ...packageHead, persons: z.array(packagePersonSchemaV2).max(5000) }).strict();
export const importPackageSchemaV3 = z
  .object({
    version: z.literal(3),
    ...packageHead,
    persons: z.array(packagePersonSchema).max(5000),
    /** Payroll Editor 有戶口但對唔到人：獨立陣列，逐條出 bank_identity_unknown 分診題 */
    unassignedBankAccounts: z.array(unassignedBankAccountSchema).max(2000).optional(),
  })
  .strict();

export const importPackageSchema = z.discriminatedUnion("version", [importPackageSchemaV2, importPackageSchemaV3]);

export type PackagePerson = z.infer<typeof packagePersonSchema>;
/** 解析後嘅統一型別（v2 人入面冇新欄＝新欄全部 undefined；v2 包冇 unassignedBankAccounts）。 */
export interface ImportPackage {
  version: 2 | 3;
  generatedAt: string;
  source?: "single_ocr";
  persons: PackagePerson[];
  unassignedBankAccounts?: UnassignedBankAccount[];
}

/** v3 先有；v2 一律空。 */
export function unassignedBankOf(pkg: ImportPackage): UnassignedBankAccount[] {
  return pkg.unassignedBankAccounts ?? [];
}

/** 包內有任何銀行欄（person.bank 有值，或者 unassignedBankAccounts 非空）→ 要「保安員銀行資料:update」。 */
export function packageHasBank(pkg: ImportPackage): boolean {
  if (unassignedBankOf(pkg).length > 0) return true;
  return pkg.persons.some((p) => !!p.bank && Object.values(p.bank).some((l) => !!l.value?.trim()));
}

/** 測試／工具用嘅人 key（HMAC，唔再係無鹽 sha1）；正式 key 見 person-key.ts */
export { personKeyForHkid } from "./person-key";

/** 欄位值（missing 或空值＝null）。 */
export function fieldValue(f: { value: string | null; status: FieldStatus }): string | null {
  if (f.status === "missing") return null;
  const v = f.value?.trim();
  return v ? v : null;
}

export interface GhostInfo {
  /** 併入嘅真人（包內 person key） */
  mergedInto: string;
  /** ghost 自己嘅工號（正規化） */
  staffNumbers: string[];
}

const personFieldsAllMissing = (p: PackagePerson): boolean => [p.hkid, p.nameZh, p.nameEn, p.dateOfBirth, p.sex, p.phone, p.address].every((f) => fieldValue(f) === null);
const personHasExt = (p: PackagePerson): boolean =>
  !!p.siaPermit || !!p.safetyCard || !!p.qas || !!p.hireDate || (p.emergencyContacts?.length ?? 0) > 0 || (!!p.bank && Object.values(p.bank).some((l) => !!l.value?.trim())) || p.staffNumbers.some((n) => !!n.hireDate?.value?.trim());

/**
 * TE-13 ghost person：由銀行戶口等文件產生嘅空記錄（rating fail／no_id_page、個人欄全部 missing、冇 ext、有工號），
 * 而且佢每個工號都只同**同一個**身份已確認（hkid confirmed 且有效）嘅包內 person 共用，
 * 該工號喺打字名單嘅身份證（listHkids，如有）同嗰個人一致 → 自動併入嗰個真人（唔出題、唔建人）。
 * 任何一點唔符合（兩個真人共用、名單 HKID 唔一致、真人冇確認身份證…）→ 唔係 ghost，照舊出題。
 */
export function findGhostPersons(persons: readonly PackagePerson[]): Map<string, GhostInfo> {
  const out = new Map<string, GhostInfo>();
  const owners = new Map<string, PackagePerson[]>();
  for (const p of persons) for (const n of p.staffNumbers) {
    const k = normalizeStaffNumber(n.number);
    owners.set(k, [...(owners.get(k) ?? []), p]);
  }
  const listOf = (p: PackagePerson, k: string): string | null => {
    for (const [no, h] of Object.entries(p.listHkids ?? {})) if (normalizeStaffNumber(no) === k) return canonicalHkid(h);
    return null;
  };
  for (const g of persons) {
    if (!(g.rating === "fail" || g.reasons.includes("no_id_page"))) continue;
    if (g.staffNumbers.length === 0 || !personFieldsAllMissing(g) || personHasExt(g)) continue;
    const nos = [...new Set(g.staffNumbers.map((n) => normalizeStaffNumber(n.number)))];
    const real = new Set<PackagePerson>();
    let ok = true;
    for (const k of nos) {
      const others = (owners.get(k) ?? []).filter((x) => x !== g);
      if (others.length !== 1) { ok = false; break; }
      real.add(others[0]!);
    }
    if (!ok || real.size !== 1) continue;
    const r = [...real][0]!;
    const rh = r.hkid.status === "confirmed" ? canonicalHkid(fieldValue(r.hkid)) : null;
    if (!rh || out.has(r.key)) continue;
    // 名單 HKID（如有）要同真人一致
    if (nos.some((k) => { const l = listOf(g, k) ?? listOf(r, k); return l !== null && l !== rh; })) continue;
    out.set(g.key, { mergedInto: r.key, staffNumbers: nos });
  }
  // 真人本身唔可以係 ghost（鏈式併入唔做）
  for (const [gk, info] of out) if (out.has(info.mergedInto)) out.delete(gk);
  return out;
}

/**
 * 包內跨人衝突：key 重複、同一 hkid 出現多次、同一工號掛喺多個人、同一電話掛喺多個人。
 * 回傳 key → 理由碼（有就該人一律 conflict，唔自動套用）。
 */
export function packageConflicts(persons: readonly PackagePerson[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, r: string) => {
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(r);
  };
  const keyCount = new Map<string, number>();
  const hkidOwner = new Map<string, string[]>();
  const noOwner = new Map<string, Set<string>>();
  const telOwner = new Map<string, Set<string>>();
  const acctOwner = new Map<string, Set<string>>();
  const ghosts = findGhostPersons(persons); // TE-13：ghost 嘅工號唔計入共用
  for (const p of persons) {
    keyCount.set(p.key, (keyCount.get(p.key) ?? 0) + 1);
    const acct = p.bank?.accountNo ? fieldValue(p.bank.accountNo) : null;
    if (acct) {
      if (!acctOwner.has(acct)) acctOwner.set(acct, new Set());
      acctOwner.get(acct)!.add(p.key);
    }
    const h = canonicalHkid(fieldValue(p.hkid));
    if (h) hkidOwner.set(h, [...(hkidOwner.get(h) ?? []), p.key]);
    for (const n of ghosts.has(p.key) ? [] : p.staffNumbers) {
      const k = normalizeStaffNumber(n.number);
      if (!noOwner.has(k)) noOwner.set(k, new Set());
      noOwner.get(k)!.add(p.key);
    }
    const t = normTel8(fieldValue(p.phone));
    if (t) {
      if (!telOwner.has(t)) telOwner.set(t, new Set());
      telOwner.get(t)!.add(p.key);
    }
    for (const c of p.conflicts ?? []) add(p.key, c);
  }
  for (const p of persons) {
    if ((keyCount.get(p.key) ?? 0) > 1) add(p.key, "duplicate_key_in_package");
    const h = canonicalHkid(fieldValue(p.hkid));
    if (h && (hkidOwner.get(h)?.length ?? 0) > 1) add(p.key, "duplicate_hkid_in_package");
    if (!ghosts.has(p.key) && p.staffNumbers.some((n) => (noOwner.get(normalizeStaffNumber(n.number))?.size ?? 0) > 1)) add(p.key, "staffno_shared_by_persons");
    const t = normTel8(fieldValue(p.phone));
    if (t && (telOwner.get(t)?.size ?? 0) > 1) add(p.key, "dup_tel_across_persons");
    const acct = p.bank?.accountNo ? fieldValue(p.bank.accountNo) : null;
    if (acct && (acctOwner.get(acct)?.size ?? 0) > 1) add(p.key, "bank_acct_shared_by_persons");
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** 導入包 sha256（parse 之後嘅 canonical JSON）：preview 回傳，apply 必須帶返同一個，確保套用嘅就係預覽過嘅。 */
export function hashPackage(pkg: ImportPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}
