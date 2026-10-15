// WP-OCR-3：HKICL 銀行代號 → 戶口號碼位數（純表，冇 PII）。
// 來源：計劃書 docs/plans/ocr-accuracy-plan.md §1 問題 3.6（HSBC 9／12、中銀 12／14、恒生 9）。
// 只收計劃書列明嘅銀行；表外銀行一律「唔檢查」（回 unknown），**唔會**因為表冇而判錯。
// 規劃者核實過其他銀行位數後喺 HKICL_ACCT_DIGITS 加行即可；位數唔啱只會令該欄降為 review（acct_digits_mismatch），唔會自動改值。
export const HKICL_ACCT_DIGITS: Readonly<Record<string, readonly number[]>> = {
  '004': [9, 12], // 香港上海匯豐銀行
  '012': [12, 14], // 中國銀行（香港）
  '024': [9], // 恒生銀行
};

export type AcctDigitsCheck = 'ok' | 'mismatch' | 'unknown_bank';

/** 戶口號碼（純數字）按銀行代號核對位數；bankCode 空／表外 → unknown_bank（唔判錯）。 */
export function acctDigitsCheck(digits: string, bankCode: string | null | undefined): AcctDigitsCheck {
  const code = (bankCode ?? '').trim().padStart(3, '0');
  const allowed = HKICL_ACCT_DIGITS[code];
  if (!allowed) return 'unknown_bank';
  return allowed.includes(digits.length) ? 'ok' : 'mismatch';
}
