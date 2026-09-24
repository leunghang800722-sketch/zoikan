// P1-WP4（Opus 驗收 A3 裁定 2026-09-12）：長工月薪分攤——`monthly-close.ts`
// 同 `gross-margin.ts` 之前用緊兩條唔同公式（前者「派晒俾更數最多嗰
// 盤」嘅簡化版；後者「按該人該月各盤更數比例分攤」）。而家統一用比例
// 分攤呢一條，兩個檔案共用呢個 helper。
//
// `monthly-close.ts` 嘅 `longtermSalaryAllocated`／`fullCost`／
// `fullProfit`／`fullMarginPct` 呢幾欄本身就係 P0 口徑*以外*嘅額外欄
// （唔影響 `revenue`／`cost`／`profit`／`marginPct` 呢幾個核心、同 P0
// 月結總表 0-diff 嘅欄——見 gate (a)／(b1)），所以呢個改動唔會影響
// 已經驗證嘅 P0 對數 gate。
import { prisma } from "@/lib/db";
import { n, round2, monthRange } from "./money";

export interface LongtermSalaryAllocationResult {
  bySite: Map<string, number>;
  /** Σ全部有出更嘅 longterm_autopay 安員月薪（唔理呢個人本月出更嘅盤
   * 使唔使全部都喺調用方嘅 site 範圍入面）——用嚟做「分攤總額 = Σ
   * monthly_salary」嘅 gate 斷言基準（Opus 驗收 A2）。 */
  totalAllocatable: number;
  /** employment_type=longterm_autopay 但本月有出更、monthly_salary 缺數
   * 嘅安員——`{ guardRef, siteIds }`（guardRef 用 staff_no 或 id，PDPO：
   * 唔用真名）。 */
  missingSalary: Array<{ guardRef: string; siteIds: string[] }>;
}

export async function buildLongtermSalaryAllocation(month: Date): Promise<LongtermSalaryAllocationResult> {
  const { start: MONTH_START, end: MONTH_END } = monthRange(month);
  const guards = await prisma.guard.findMany({
    where: { employmentType: "longterm_autopay" },
    include: {
      shiftRecords: {
        where: { workDate: { gte: MONTH_START, lte: MONTH_END }, recordType: "shift", status: { not: "cancelled" } },
        select: { siteId: true },
      },
    },
  });

  const bySite = new Map<string, number>();
  let totalAllocatable = 0;
  const missingSalary: Array<{ guardRef: string; siteIds: string[] }> = [];

  for (const g of guards) {
    if (g.shiftRecords.length === 0) continue;
    const shiftsBySite = new Map<string, number>();
    for (const sr of g.shiftRecords) shiftsBySite.set(sr.siteId, (shiftsBySite.get(sr.siteId) ?? 0) + 1);
    const totalShifts = g.shiftRecords.length;

    if (g.monthlySalary === null) {
      missingSalary.push({ guardRef: g.staffNo ?? g.id, siteIds: [...shiftsBySite.keys()] });
      continue;
    }
    const salary = n(g.monthlySalary);
    totalAllocatable = round2(totalAllocatable + salary);
    for (const [siteId, cnt] of shiftsBySite) {
      const share = round2((salary * cnt) / totalShifts);
      bySite.set(siteId, round2((bySite.get(siteId) ?? 0) + share));
    }
  }

  return { bySite, totalAllocatable: round2(totalAllocatable), missingSalary };
}
