// WP-OCR-3：HKICL 銀行代號 → 戶口號碼位數（純表，冇 PII）。
// 驗收 S2：規劃者核實過 Payroll Editor 同打字名單嘅戶口位數分佈——各來源有冇帶銀行代號／分行碼／前置零並不統一
// （同一銀行出現 13／15、7／9 等多種位數），現階段開檢查會製造大量假 review，所以**表暫時清空**。
// 待戶口格式正規化後再填；函數同 unknown_bank 路徑保留（表空＝全部 unknown_bank，唔判錯）。
export const HKICL_ACCT_DIGITS: Readonly<Record<string, readonly number[]>> = {};

export type AcctDigitsCheck = 'ok' | 'mismatch' | 'unknown_bank';

/** 戶口號碼（純數字）按銀行代號核對位數；bankCode 空／表外 → unknown_bank（唔判錯）。 */
export function acctDigitsCheck(digits: string, bankCode: string | null | undefined): AcctDigitsCheck {
  const code = (bankCode ?? '').trim().padStart(3, '0');
  const allowed = HKICL_ACCT_DIGITS[code];
  if (!allowed) return 'unknown_bank';
  return allowed.includes(digits.length) ? 'ok' : 'mismatch';
}
