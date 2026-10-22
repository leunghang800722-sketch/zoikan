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
