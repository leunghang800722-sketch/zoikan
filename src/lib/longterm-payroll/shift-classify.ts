// 長工正更歸類（aggregate 同 cover-shifts 共用，避免「頂位更」認定日後分叉）：
//   settlement＝B07（internal_longterm）→ 自己崗位；有值但唔係 B07 → 幫雞頭頂散更（頂位）；null → 保守當自己崗位（人手覆核）。
// 崗位盤（含母盤／構造盤 activityProxy 摺疊、Postorder 權威月只認 manual）嘅判斷已經喺對數階段寫入 settlement_broker_id，呢度只讀結果。
//
// EMP-P2（老闆 2026-10-20 拍板）：長工用 U／MP 卡開散更 **唔計** 頂位津貼（散更糧已經由出糧方出咗）。
// 由 `LONGTERM_SCATTER_EFFECTIVE_FROM`（2026-10-01）起，歸類先考慮更次 `staff_scheme`（P1 寫入嘅工號卡歸屬），
// 但 `scatter` 只適用於「本來會判 cover」嘅更（settlement 有值而且唔係 B07）：
//   - settlement＝B07 → 永遠 own（自己崗位，計返工日；就算 scheme＝U／MP 都係，否則日薪制 workDays 會少計）；
//   - settlement＝null → 永遠 own_unsettled（保守當自己崗位，人手覆核）；
//   - settlement 有值且唔係 B07（原本判 cover）：scheme 係長工體系（is_longterm，出廠 MG）→ own；
//     scheme 係前線散更體系（is_frontline，出廠 U／MP）→ scatter（唔當長工返工日，亦唔計頂位津貼）；
//     冇 scheme／未知 scheme／其他體系 → 照舊 cover（一律落返 settlement 邏輯）。
// 生效日係固定常數（唔係「最早未鎖月」動態值），令已鎖月重算結果唔會因為之後鎖咗邊個月而郁；7／8／9 月行舊邏輯，10 月係第一個肯定未鎖嘅月。
// 要改生效日：只改下面 `LONGTERM_SCATTER_EFFECTIVE_FROM`（同 docs/api.md「EMP-P2」一節），重算已出糧嘅月份唔會自動郁。
import type { StaffSchemeInfo } from "@/lib/guards/staff-schemes";

export type LongtermShiftKind = "own" | "own_unsettled" | "cover" | "scatter";

/** 頂位規則生效首日（含）；之前嘅月份（7／8 月）行舊邏輯。老闆 2026-10-20 拍板。 */
export const LONGTERM_SCATTER_EFFECTIVE_FROM = new Date(Date.UTC(2026, 9, 1));

export function classifyLongtermShift(
  settlementBrokerId: string | null,
  internalLongtermBrokerId: string | null,
  opts?: { staffScheme: string | null; workDate: Date; schemes: ReadonlyMap<string, StaffSchemeInfo> },
): LongtermShiftKind {
  if (internalLongtermBrokerId && settlementBrokerId === internalLongtermBrokerId) return "own";
  if (!settlementBrokerId) return "own_unsettled";
  // 以下 settlement 有值而且唔係 B07（舊邏輯會判 cover）
  if (opts && opts.staffScheme && opts.workDate.getTime() >= LONGTERM_SCATTER_EFFECTIVE_FROM.getTime()) {
    const info = opts.schemes.get(opts.staffScheme); // 未知 scheme → undefined → 落返 cover
    if (info?.isLongterm) return "own";
    if (info?.isFrontline) return "scatter";
  }
  return "cover";
}
