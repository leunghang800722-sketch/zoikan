// WP-ONE-CLICK-AUTO（§31.3 D）：客戶自己人（external 雞頭，例如 B10 別名
// 「Wilson Guard／Wilson Supervisor」）——更表 rank／姓名欄命中 external 雞頭
// 嘅別名（或代號）→ 歸 external，永遠分開計（唔入本月更數主數、唔入收入／成本）。
// 純函數，零 DB 依賴；service.ts（解析時）同一鍵結算（更數異常拆解）共用。
export interface ExternalBrokerLite {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

function tokens(raw: string): string[] {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** `text` 嘅開頭 token 序列等於某個別名（或代號）嘅 token 序列 → 命中。
 * 「Wilson Guard」「Wilson Guard 2」命中別名「Wilson Guard」；「測試外判甲」唔中。 */
export function matchExternalAlias(text: string | null | undefined, externals: readonly ExternalBrokerLite[]): ExternalBrokerLite | null {
  if (!text) return null;
  const t = tokens(text);
  if (t.length === 0) return null;
  const hits: ExternalBrokerLite[] = [];
  for (const b of externals) {
    const names = [b.code, ...b.aliases];
    const matched = names.some((n) => {
      const nt = tokens(n);
      return nt.length > 0 && nt.length <= t.length && nt.every((tok, i) => t[i] === tok);
    });
    if (matched) hits.push(b);
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** 一行更表格：rank 或姓名命中 external 雞頭別名。 */
export function externalBrokerForRow(row: { rankRaw?: string | null; nameRaw?: string | null }, externals: readonly ExternalBrokerLite[]): ExternalBrokerLite | null {
  if (externals.length === 0) return null;
  return matchExternalAlias(row.rankRaw, externals) ?? matchExternalAlias(row.nameRaw, externals);
}
