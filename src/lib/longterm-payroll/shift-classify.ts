// 長工正更歸類（aggregate 同 cover-shifts 共用，避免「頂位更」認定日後分叉）：
//   settlement＝B07（internal_longterm）→ 自己崗位；有值但唔係 B07 → 幫雞頭頂散更（頂位）；null → 保守當自己崗位（人手覆核）。
// 崗位盤（含母盤／構造盤 activityProxy 摺疊、Postorder 權威月只認 manual）嘅判斷已經喺對數階段寫入 settlement_broker_id，呢度只讀結果。
export type LongtermShiftKind = "own" | "own_unsettled" | "cover";

export function classifyLongtermShift(settlementBrokerId: string | null, internalLongtermBrokerId: string | null): LongtermShiftKind {
  if (internalLongtermBrokerId && settlementBrokerId === internalLongtermBrokerId) return "own";
  if (settlementBrokerId) return "cover";
  return "own_unsettled";
}
