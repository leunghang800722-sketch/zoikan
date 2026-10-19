// WP-STAFF-IMPORT Stage B1（§26.4）：保安員「身份證號碼＋電話號碼」唯一識別
// 嘅純函數＋重複檢查。身份證（canonical）係「人」嘅主鍵；電話（guard_phones.tel）
// 全表唯一，係更表配對鍵。
//
// 重複擋 409 嘅訊息**唔准**回顯對方姓名／完整號碼／guard id。
import type { Prisma, PrismaClient } from "@prisma/client";
import { Conflict, BadRequest } from "../api/errors";

import { canonicalHkid, hkidCheckDigitValid } from "./hkid-pure";
export { canonicalHkid, hkidSearchKey, formatHkid, hkidCheckDigitValid } from "./hkid-pure";

/** 電話正規化（香港）：去空白／連字符／括號／點；`+852`／`852`／`00852` 前綴 + 8 位 → 8 位；
 * 其餘（國際號）保留 `+` 同數字。冇有效內容 → null。 */
export function normalizeTelHk(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.normalize("NFKC").replace(/[\s\-().]+/g, "");
  if (!s) return null;
  const m = s.match(/^(?:\+|00)?852(\d{8})$/);
  if (m) s = m[1]!;
  return /^\+?\d{7,15}$/.test(s) ? s : null;
}

/** 同一個號碼可能以 8 位／852／+852 存入 DB；查重時三種寫法都要查。 */
export function telLookupVariants(raw: string | null | undefined): string[] {
  const n = normalizeTelHk(raw);
  if (!n) return [];
  return /^\d{8}$/.test(n) ? [n, `852${n}`, `+852${n}`] : [n];
}

export type IdentityStatus = "complete" | "missing_hkid" | "missing_tel" | "missing_both";

/** 識別狀態：有冇身份證（canonical 格式）＋有冇電話。 */
export function identityStatus(g: { hkid?: string | null; tel?: string | null; hasPhone?: boolean }): IdentityStatus {
  const hasHkid = !!(g.hkid && g.hkid.trim());
  const hasTel = g.hasPhone ?? !!(g.tel && g.tel.trim());
  if (hasHkid && hasTel) return "complete";
  if (!hasHkid && hasTel) return "missing_hkid";
  if (hasHkid && !hasTel) return "missing_tel";
  return "missing_both";
}

type Db = PrismaClient | Prisma.TransactionClient;

/** hkid 入庫前處理：回傳 canonical。格式唔係身份證 → 400；check digit 唔啱 → 400
 * （`allowInvalid` 俾護照號等，此時格式不限，只做 trim＋大寫去空白）。 */
export function prepareHkidForWrite(raw: string, opts: { allowInvalid?: boolean } = {}): string {
  const canon = canonicalHkid(raw);
  if (canon) {
    if (!opts.allowInvalid && !hkidCheckDigitValid(canon)) {
      throw BadRequest("身份證號碼 check digit 唔啱（如果係護照或特殊證件號，請加 allow_invalid_hkid）");
    }
    return canon;
  }
  if (opts.allowInvalid) {
    const loose = raw.toUpperCase().replace(/[\s　]+/g, "");
    if (loose) return loose;
  }
  throw BadRequest("身份證格式唔啱（例如 A123456(3)）");
}

/** 擋重複身份證（app 層；DB unique index 存在與否都要擋）。訊息不回顯對方資料。 */
export async function assertHkidAvailable(db: Db, canon: string, exceptGuardId?: string | null): Promise<void> {
  const hit = await db.guard.findFirst({ where: { hkid: canon, ...(exceptGuardId ? { id: { not: exceptGuardId } } : {}) }, select: { id: true } });
  if (hit) throw Conflict("呢個身份證號碼已經登記喺另一個保安員", { field: "hkid" });
}

/** 擋重複電話（全表唯一；8 位／852／+852 三種寫法都查）。 */
export async function assertTelAvailable(db: Db, rawTel: string, exceptGuardId?: string | null): Promise<void> {
  const variants = telLookupVariants(rawTel);
  if (variants.length === 0) return;
  const hit = await db.guardPhone.findFirst({
    where: { tel: { in: variants }, ...(exceptGuardId ? { guardId: { not: exceptGuardId } } : {}) },
    select: { id: true },
  });
  if (hit) throw Conflict("呢個電話號碼已經登記喺另一個保安員", { field: "tel" });
}

/** DB unique index（guards_hkid_key／guard_phones_tel_key）race 撞到嘅 P2002 → 一般 409
 * （不回顯對方資料）；其他 error 原樣 rethrow。 */
export function rethrowIdentityConflict(err: unknown): never {
  if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
    const text = JSON.stringify((err as { meta?: unknown }).meta ?? "") + String((err as { message?: string }).message ?? "");
    if (/guards_hkid_key|hkid/.test(text)) throw Conflict("呢個身份證號碼已經登記喺另一個保安員", { field: "hkid" });
    if (/guard_phones_tel_key|tel/.test(text) && !/guard_id/.test(text)) throw Conflict("呢個電話號碼已經登記喺另一個保安員", { field: "tel" });
  }
  throw err;
}
