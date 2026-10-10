// P3-3.6：雞頭 Drawer「銀行名」「戶口號碼」兩格 ⇄ `brokers.bank_info` JSON。
// 以前要老闆手打 JSON（提示例：{"bank_name":"...","account_no":"..."}）。API 不變——仍然送同一個 `bank_info` JSON。
// 舊 JSON 入面其他 key 一律保留唔動（只改呢兩個 key）；若舊 JSON 已用其他拼寫（bankName／account_number 等），沿用嗰個 key。
// 銀行資料屬 PII：呢個檔純函數，唔 log、test 只用假值。
const NAME_KEYS = ["bank_name", "bankName", "bank"] as const;
const ACCOUNT_KEYS = ["account_no", "account_number", "bank_account_no", "accountNo", "accountNumber"] as const;

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Json) } : {};
}

function pickKey(obj: Json, candidates: readonly string[]): string {
  return candidates.find((k) => k in obj) ?? candidates[0]!;
}

/** 由現有 bank_info 取出兩格嘅值（唔係字串就當空）。 */
export function readBankFields(info: unknown): { bankName: string; accountNo: string } {
  const o = asObject(info);
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return { bankName: s(o[pickKey(o, NAME_KEYS)]), accountNo: s(o[pickKey(o, ACCOUNT_KEYS)]) };
}

/** 兩格 → 要送出嘅 bank_info。回 `undefined`＝唔送（原本冇、而家兩格都空）。 */
export function buildBankInfo(existing: unknown, bankName: string, accountNo: string): Json | undefined {
  const base = asObject(existing);
  const nameKey = pickKey(base, NAME_KEYS);
  const accKey = pickKey(base, ACCOUNT_KEYS);
  const name = bankName.trim();
  const acc = accountNo.trim();
  const hadAny = Object.keys(base).length > 0;
  if (name) base[nameKey] = name;
  else delete base[nameKey];
  if (acc) base[accKey] = acc;
  else delete base[accKey];
  if (!hadAny && !name && !acc) return undefined;
  return base;
}
