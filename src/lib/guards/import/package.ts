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

export const FIELD_STATUSES = ["confirmed", "review", "missing"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const PERSON_FIELDS = ["hkid", "nameZh", "nameEn", "dateOfBirth", "sex", "phone", "address"] as const;
export type PersonField = (typeof PERSON_FIELDS)[number];

const fieldSchema = z.object({ value: z.string().max(500).nullable(), status: z.enum(FIELD_STATUSES) }).strict();

/** 地址來源：住址證明（預設，舊包冇 source 當呢個）／申請表（冇住址證明嘅人，老闆 2026-10-03 決定）。 */
export const ADDRESS_SOURCES = ["address_proof", "application_form"] as const;
export type AddressSource = (typeof ADDRESS_SOURCES)[number];
const addressFieldSchema = z
  .object({ value: z.string().max(500).nullable(), status: z.enum(FIELD_STATUSES), source: z.enum(ADDRESS_SOURCES).optional() })
  .strict();

export function addressSourceOf(a: { source?: AddressSource }): AddressSource {
  return a.source ?? "address_proof";
}

export const packagePersonSchema = z
  .object({
    key: z.string().min(1).max(64),
    hkid: fieldSchema,
    nameZh: fieldSchema,
    nameEn: fieldSchema,
    dateOfBirth: fieldSchema,
    sex: fieldSchema,
    phone: fieldSchema,
    address: addressFieldSchema,
    staffNumbers: z.array(z.object({ scheme: z.string().min(1).max(8), number: z.string().min(1).max(32) }).strict()).max(20),
    rating: z.enum(["auto_ok", "review", "fail"]),
    reasons: z.array(z.string().max(80)).max(60),
    /** 包內群組層面衝突理由（例如同 hkid 不同檔中文名差異大）；有就一律 conflict。 */
    conflicts: z.array(z.string().max(80)).max(20).optional(),
  })
  .strict();

export const importPackageSchema = z
  .object({
    version: z.literal(2),
    generatedAt: z.string().max(40),
    persons: z.array(packagePersonSchema).max(5000),
  })
  .strict();

export type PackagePerson = z.infer<typeof packagePersonSchema>;
export type ImportPackage = z.infer<typeof importPackageSchema>;

export function personKeyForHkid(canon: string): string {
  return createHash("sha1").update(canon).digest("hex");
}

/** 欄位值（missing 或空值＝null）。 */
export function fieldValue(f: { value: string | null; status: FieldStatus }): string | null {
  if (f.status === "missing") return null;
  const v = f.value?.trim();
  return v ? v : null;
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
  for (const p of persons) {
    keyCount.set(p.key, (keyCount.get(p.key) ?? 0) + 1);
    const h = canonicalHkid(fieldValue(p.hkid));
    if (h) hkidOwner.set(h, [...(hkidOwner.get(h) ?? []), p.key]);
    for (const n of p.staffNumbers) {
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
    if (p.staffNumbers.some((n) => (noOwner.get(normalizeStaffNumber(n.number))?.size ?? 0) > 1)) add(p.key, "staffno_shared_by_persons");
    const t = normTel8(fieldValue(p.phone));
    if (t && (telOwner.get(t)?.size ?? 0) > 1) add(p.key, "dup_tel_across_persons");
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** 導入包 sha256（parse 之後嘅 canonical JSON）：preview 回傳，apply 必須帶返同一個，確保套用嘅就係預覽過嘅。 */
export function hashPackage(pkg: ImportPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}
