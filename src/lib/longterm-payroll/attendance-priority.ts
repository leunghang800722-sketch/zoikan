// P18.1：同一人同一日多來源更表紀錄 → 按來源優先次序揀（純函數，client／server 共用，唔 import 任何 server 模組）。
// 優先：manual（人手編輯：更表編輯器／batch API 寫 source="manual"）> roster_upload > master_roster > payroll_only > 其他／null。
// 只揀「出勤紀錄」（record_type=shift／leave）；OT 紀錄（record_type=ot）唔受來源優先影響，照舊全部計。
// 同一最高來源同日多條（例如雙更）照舊全部計。只改紀錄挑選，唔掂任何金額公式。

export const MANUAL_SOURCE = "manual";
const NO_SOURCE_LABEL = "（無來源）";

const SOURCE_RANK: Record<string, number> = { [MANUAL_SOURCE]: 0, roster_upload: 1, master_roster: 2, payroll_only: 3 };
const OTHER_RANK = 4;

/** 數字愈細優先愈高；唔認得／null 一律同一級（最低）。 */
export function sourceRank(source: string | null | undefined): number {
  if (!source) return OTHER_RANK;
  return SOURCE_RANK[source] ?? OTHER_RANK;
}

export function sourceLabel(source: string | null | undefined): string {
  return source ? source : NO_SOURCE_LABEL;
}

type AttendanceLike = { workDate: Date; recordType: string; source: string | null };

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
export function pickBySourcePriority<T extends AttendanceLike>(srs: readonly T[]): { picked: T[]; adoptions: Map<string, DayAdoption> } {
  const bestRank = new Map<string, number>();
  for (const r of srs) {
    if (r.recordType !== "shift" && r.recordType !== "leave") continue;
    const d = r.workDate.toISOString().slice(0, 10);
    const rank = sourceRank(r.source);
    const cur = bestRank.get(d);
    if (cur === undefined || rank < cur) bestRank.set(d, rank);
  }
  const picked: T[] = [];
  const adoptedByDay = new Map<string, Set<string>>();
  const ignoredByDay = new Map<string, Set<string>>();
  for (const r of srs) {
    if (r.recordType !== "shift" && r.recordType !== "leave") {
      picked.push(r);
      continue;
    }
    const d = r.workDate.toISOString().slice(0, 10);
    if (sourceRank(r.source) === bestRank.get(d)) {
      picked.push(r);
      const s = adoptedByDay.get(d) ?? new Set<string>();
      s.add(sourceLabel(r.source));
      adoptedByDay.set(d, s);
    } else {
      const s = ignoredByDay.get(d) ?? new Set<string>();
      s.add(sourceLabel(r.source));
      ignoredByDay.set(d, s);
    }
  }
  const adoptions = new Map<string, DayAdoption>();
  for (const [d, ign] of ignoredByDay) {
    adoptions.set(d, { adopted: [...(adoptedByDay.get(d) ?? [])].sort().join("／"), ignored: [...ign].sort() });
  }
  return { picked, adoptions };
}
