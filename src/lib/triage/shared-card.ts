// TE-13：「同一工號／電話出現喺多個人」題卡嘅白話文案（純函數，無 PII 值）。
export type SharedKind = "staffno_shared_by_persons" | "dup_tel_across_persons";
export const isSharedKind = (k: string): k is SharedKind => k === "staffno_shared_by_persons" || k === "dup_tel_across_persons";

/** 頂部一句：工號 U01xxx 同時出現喺 N 個人身上，請揀邊個先係真正用呢個工號 */
export function sharedHeadline(kind: SharedKind, staffNumbers: readonly string[], others: number): string {
  const n = others + 1;
  if (kind === "dup_tel_across_persons") return `呢個電話同時出現喺 ${n} 個人身上，請揀邊個先係真正用呢個電話`;
  const nos = staffNumbers.length ? `工號 ${staffNumbers.join("、")}` : "呢個工號";
  return `${nos} 同時出現喺 ${n} 個人身上，請揀邊個先係真正用呢個工號`;
}

const HKID_STATUS_LABEL: Record<string, string> = { confirmed: "已確認", review: "待核對", missing: "未讀到" };
export const hkidStatusLabel = (s: string): string => HKID_STATUS_LABEL[s] ?? "未讀到";

/** 「冇裁圖」按 kind 分：爭議類題目唔需要裁圖；真係讀唔到先講讀唔到 */
export function noCropText(kind: string | undefined): string {
  return kind && isSharedKind(kind) ? "呢類題目唔需要裁圖" : "冇裁圖（文件讀唔到）";
}

/** TE-13.2：非身份文件頁種類（ghost 只可以得呢啲）同顯示名 */
const NON_IDENTITY_KIND_LABEL: Record<string, string> = { bank: "銀行", blank: "空白", sia_permit: "牌照", safety_card: "平安咭" };
export const isNonIdentityKinds = (pagesByKind: Record<string, number> | undefined): boolean => {
  const ks = Object.entries(pagesByKind ?? {}).filter(([, n]) => n > 0).map(([k]) => k);
  return ks.length > 0 && ks.every((k) => k in NON_IDENTITY_KIND_LABEL);
};
/** 「2 頁銀行文件」「3 頁銀行、牌照文件」——按實際 pagesByKind 寫，唔寫死 */
export function ghostDocText(pagesByKind: Record<string, number> | undefined, pageCount: number): string {
  const labels = Object.entries(pagesByKind ?? {}).filter(([, n]) => n > 0).map(([k]) => NON_IDENTITY_KIND_LABEL[k] ?? k);
  const total = Object.values(pagesByKind ?? {}).reduce((a, n) => a + n, 0) || pageCount;
  return `${total} 頁${labels.join("、")}文件`;
}
