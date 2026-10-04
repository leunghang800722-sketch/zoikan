// WP-STAFF-IMPORT Stage B1（§26.4）：保安員「身份證號碼＋電話號碼」唯一識別
// 嘅純函數＋重複檢查。身份證（canonical）係「人」嘅主鍵；電話（guard_phones.tel）
// 全表唯一，係更表配對鍵。
//
// 重複擋 409 嘅訊息**唔准**回顯對方姓名／完整號碼／guard id。
import type { Prisma, PrismaClient } from "@prisma/client";
import { Conflict, BadRequest } from "../api/errors";

/** canonical key：大寫、去空白（含全形空白）、去半形／全形括號。唔係身份證格式就 null。
 * （搬自 src/lib/guard-fix/sources.ts，原處 re-export。） */
export function canonicalHkid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[\s　]+/g, "").replace(/[()（）]/g, "");
  return /^[A-Z]{1,2}\d{6}[0-9A]$/.test(s) ? s : null;
}

/** q → 身份證搜尋 key：canonical 式正規化（大寫、去空白／全形空白、去半形／全形括號、全形英數轉半形）；長度 ≥4 先當 hkid 搜。 */
export function hkidSearchKey(q: string): string | null {
  const k = q
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s　]+/g, "")
    .replace(/[()（）]/g, "");
  return /^[A-Z0-9]{4,}$/.test(k) ? k : null;
}

/** canonical → 顯示格式 `A123456(3)`。 */
export function formatHkid(canon: string): string {
  return `${canon.slice(0, -1)}(${canon.slice(-1)})`;
}

/** 香港身份證 check digit（mod 11）。單字母前綴當第一位係空格（值 36）。
 * 合法範例：`A123456(3)`（註：`A123456(7)` 嘅 check digit 係錯嘅）。接受 canonical 或帶括號寫法。 */
export function hkidCheckDigitValid(raw: string | null | undefined): boolean {
  const canon = canonicalHkid(raw);
  if (!canon) return false;
  const letters = canon.match(/^[A-Z]+/)![0];
  const digits = canon.slice(letters.length, -1);
  const check = canon.slice(-1);
  const val = (ch: string) => ch.charCodeAt(0) - 55; // A=10
  const first = letters.length === 2 ? val(letters[0]!) : 36;
  const second = val(letters[letters.length - 1]!);
  let sum = first * 9 + second * 8;
  for (let i = 0; i < 6; i++) sum += Number(digits[i]) * (7 - i);
  const checkVal = check === "A" ? 10 : Number(check);
  return (sum + checkVal) % 11 === 0;
}

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
  if (hit) throw Conflict("呢個身份證號碼已經登記喺另一個安員", { field: "hkid" });
}

/** 擋重複電話（全表唯一；8 位／852／+852 三種寫法都查）。 */
export async function assertTelAvailable(db: Db, rawTel: string, exceptGuardId?: string | null): Promise<void> {
  const variants = telLookupVariants(rawTel);
  if (variants.length === 0) return;
  const hit = await db.guardPhone.findFirst({
    where: { tel: { in: variants }, ...(exceptGuardId ? { guardId: { not: exceptGuardId } } : {}) },
    select: { id: true },
  });
  if (hit) throw Conflict("呢個電話號碼已經登記喺另一個安員", { field: "tel" });
}

/** DB unique index（guards_hkid_key／guard_phones_tel_key）race 撞到嘅 P2002 → 一般 409
 * （不回顯對方資料）；其他 error 原樣 rethrow。 */
export function rethrowIdentityConflict(err: unknown): never {
  if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
    const text = JSON.stringify((err as { meta?: unknown }).meta ?? "") + String((err as { message?: string }).message ?? "");
    if (/guards_hkid_key|hkid/.test(text)) throw Conflict("呢個身份證號碼已經登記喺另一個安員", { field: "hkid" });
    if (/guard_phones_tel_key|tel/.test(text) && !/guard_id/.test(text)) throw Conflict("呢個電話號碼已經登記喺另一個安員", { field: "tel" });
  }
  throw err;
}
