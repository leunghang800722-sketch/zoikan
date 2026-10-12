// P14：英文名 normalize（銀行 Payroll Editor「員工賬戶名稱」係英文大寫、有空格；Maxwell／guards.nameEn 大小寫、標點、空格各異）。
// 配對一律比對 normalize 後字串：大寫、去所有非 A-Z0-9。純函數，零 DB 依賴。
import { createHash } from "node:crypto";

export function normalizeEnName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 銀行名只存 sha256（PII 最小化），唔存原文。 */
export function hashNormalizedName(norm: string): string {
  return createHash("sha256").update(norm).digest("hex");
}
