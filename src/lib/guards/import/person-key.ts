// WP-STAFF-FIELDS（Opus 覆核第三輪 R3）：所有由身份證／工號／戶口衍生嘅 key 一律用 HMAC-SHA256
// （key 由 SESSION_SECRET 經固定 label 衍生；冇 secret 就 throw），輸出截 24 hex。集中喺呢個檔。
// 唔准再用 sha1／sha256(身份證) 之類無鹽 hash：身份證空間細，無鹽 hash 秒級可以窮舉反推。
// 包內 `key` 係上載者提供（可能含／衍生自身份證），**唔會**出現喺任何回應、題目 group_key、evidence、audit。
import { createHmac } from "node:crypto";
import { canonicalHkid } from "@/lib/guards/identity";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";

const LABEL = "zoikan:person-key:v1";

function derivedKey(): Buffer {
  const k = process.env.SESSION_SECRET;
  if (!k || k.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return createHmac("sha256", k).update(LABEL).digest();
}

/** HMAC(類別|值) 截 24 hex。 */
export function hmacRef(kind: string, value: string): string {
  return createHmac("sha256", derivedKey()).update(`${kind}|${value}`).digest("hex").slice(0, 24);
}

export function personKeyForHkid(canon: string): string {
  return hmacRef("hkid", canon);
}

interface KeyablePerson {
  key: string;
  hkid: { value: string | null };
  staffNumbers: { number: string }[];
}
/** 人嘅穩定 key：有合法格式身份證（任何 status）→ HMAC(身份證)；否則 HMAC(工號集合)；再否則 HMAC(包內 key)。 */
export function serverPersonKey(p: KeyablePerson): string {
  const h = canonicalHkid(p.hkid.value?.trim() || null);
  if (h) return hmacRef("hkid", h);
  const nos = [...new Set(p.staffNumbers.map((n) => normalizeStaffNumber(n.number)))].sort();
  if (nos.length) return hmacRef("staffnos", nos.join(","));
  return hmacRef("pkgkey", p.key);
}

/** 對唔到人嘅收款戶口嘅題目 key。 */
export function bankAccountRef(code: string, accountNo: string): string {
  return hmacRef("bankacct", `${code.padStart(3, "0")}:${accountNo.replace(/[^0-9]/g, "")}`);
}
