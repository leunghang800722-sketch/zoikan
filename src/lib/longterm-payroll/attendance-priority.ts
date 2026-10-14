// P18.1：同一人同一日多來源更表紀錄 → 按來源優先次序揀（純函數，client／server 共用，唔 import 任何 server 模組）。
// 優先：manual（人手編輯：更表編輯器／batch API／單條 shift-records API 寫 source="manual"）> roster_upload
//   > master_roster（含 master_roster_only／master_roster_site 同級）> payroll_only（含 payroll 同級）> 其他／null。
// 分組：shift 按（日, 盤）揀最高來源（自己崗位 B07＋頂位同日兩邊保留）；leave 逐日同全日所有盤紀錄比較，低級來源嘅 leave 一律忽略。
// 只揀「出勤紀錄」（record_type=shift／leave）；OT 紀錄（record_type=ot）唔受來源優先影響，照舊全部計。
// 同一最高來源同日多條（例如雙更）照舊全部計。只改紀錄挑選，唔掂任何金額公式。

export const MANUAL_SOURCE = "manual";
const NO_SOURCE_LABEL = "（無來源）";

const SOURCE_RANK: Record<string, number> = {
  [MANUAL_SOURCE]: 0,
  roster_upload: 1,
  master_roster: 2,
  master_roster_only: 2,
  master_roster_site: 2,
  payroll_only: 3,
  payroll: 3,
};
const OTHER_RANK = 4;

/** 數字愈細優先愈高；唔認得／null 一律同一級（最低）。 */
export function sourceRank(source: string | null | undefined): number {
  if (!source) return OTHER_RANK;
  return SOURCE_RANK[source] ?? OTHER_RANK;
}

export function sourceLabel(source: string | null | undefined): string {
  return source ? source : NO_SOURCE_LABEL;
}

type AttendanceLike = { workDate: Date; recordType: string; source: string | null; siteId?: string | null; guardId?: string | null };

/** 優先次序分組 key：日 + 盤（冇 siteId 當同一盤）。 */
const dayKey = (r: { workDate: Date; siteId?: string | null; guardId?: string | null }): string => `${r.guardId ?? ""}|${r.workDate.toISOString().slice(0, 10)}|${r.siteId ?? ""}`;
/** 優先次序分組 key（人, 日）；冇 guardId 當同一個人。caller 可以一次過交多人紀錄，helper 唔會跨人污染。 */
const personDayKey = (r: { workDate: Date; guardId?: string | null }): string => `${r.guardId ?? ""}|${r.workDate.toISOString().slice(0, 10)}`;

export interface DayAdoption {
  /** 該日被採用嘅來源標籤（同級多個來源以「／」相連）。 */
  adopted: string;
  /** 該日被忽略嘅來源標籤（已排序、去重）。 */
  ignored: string[];
}

/**
 * 每日只保留最高優先級來源嘅 shift／leave 紀錄；ot 紀錄原樣保留。
 * 回傳 picked（保持原有次序）同「有被忽略來源」嘅日子（key＝YYYY-MM-DD）。
 */
export function pickBySourcePriority<T extends AttendanceLike>(srs: readonly T[]): { picked: T[]; ignored: T[]; adoptions: Map<string, DayAdoption> } {
  // 規則（P18 驗收 M4）：
  //  - shift：按（日, 盤）分組，同組（shift＋leave）取最高來源——自己崗位＋頂位同日兩邊保留；
  //  - 最高級來源當日只有 leave（冇 shift）→ 該日所有低級來源嘅 shift（任何盤）一律忽略；
  //  - leave：逐日同全日所有紀錄（所有盤、shift 或 leave）比較，當日最高級來源有任何紀錄，低級來源嘅 leave 一律忽略。
  const groupBest = new Map<string, number>();
  const dayBest = new Map<string, number>();
  for (const r of srs) {
    if (r.recordType !== "shift" && r.recordType !== "leave") continue;
    const rank = sourceRank(r.source);
    const k = dayKey(r);
    const d = personDayKey(r);
    if (rank < (groupBest.get(k) ?? Infinity)) groupBest.set(k, rank);
    if (rank < (dayBest.get(d) ?? Infinity)) dayBest.set(d, rank);
  }
  // 最高級來源當日有冇 shift；冇（只有 leave）→ 低級來源嘅 shift（任何盤）一律忽略
  const dayBestHasShift = new Map<string, boolean>();
  for (const r of srs) {
    if (r.recordType !== "shift") continue;
    const d = personDayKey(r);
    if (sourceRank(r.source) === dayBest.get(d)) dayBestHasShift.set(d, true);
  }
  const picked: T[] = [];
  const ignored: T[] = [];
  const adoptedByDay = new Map<string, Set<string>>();
  const ignoredByDay = new Map<string, Set<string>>();
  for (const r of srs) {
    if (r.recordType !== "shift" && r.recordType !== "leave") {
      picked.push(r);
      continue;
    }
    const d = personDayKey(r);
    const rank = sourceRank(r.source);
    const keep = r.recordType === "shift" ? rank === dayBest.get(d) || (!!dayBestHasShift.get(d) && rank === groupBest.get(dayKey(r))) : rank === dayBest.get(d);
    if (keep) {
      picked.push(r);
      const set = adoptedByDay.get(d) ?? new Set<string>();
      set.add(sourceLabel(r.source));
      adoptedByDay.set(d, set);
    } else {
      ignored.push(r);
      const set = ignoredByDay.get(d) ?? new Set<string>();
      set.add(sourceLabel(r.source));
      ignoredByDay.set(d, set);
    }
  }
  // adoptions 以（guardId|日期）做 key（冇 guardId 即 "|YYYY-MM-DD"）（只列有來源被忽略嘅日子；多盤時合併）
  const adoptions = new Map<string, DayAdoption>();
  for (const [d, ign] of ignoredByDay) {
    adoptions.set(d, { adopted: [...(adoptedByDay.get(d) ?? [])].sort().join("／"), ignored: [...ign].sort() });
  }
  return { picked, ignored, adoptions };
}
