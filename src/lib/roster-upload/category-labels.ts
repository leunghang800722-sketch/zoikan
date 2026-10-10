// P3-3.5：對數分類中文 label（單一真相）——對數頁（ReconcileClient）同「重新對數全月結果」面板共用，
// 畫面唔再出現 roster_only／settlement_diff 呢類英文 key。
export type ReconcileCategory = "match" | "roster_only" | "system_only" | "guard_diff" | "settlement_diff" | "shift_type_diff" | "unresolved";

export const CATEGORY_LABEL: Record<ReconcileCategory, string> = {
  match: "一致",
  roster_only: "更表有・系統冇",
  system_only: "系統有・更表冇",
  guard_diff: "人唔同",
  settlement_diff: "結算單位唔同",
  shift_type_diff: "更別唔同",
  unresolved: "未配對（唔可以寫入）",
};
