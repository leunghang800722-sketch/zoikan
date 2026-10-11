// P10.1：頂位津貼價目表（逐盤逐職級）。純函數＋DB 讀取（唔寫）；寫入在 API route／adopt 服務。
// 職級 grade＝"IC"／"兵"（更表 Rank 欄經 `classifyRank` 分類；冇 Rank 就跟更別 billing_group=monthly_ic／code 含 IC）。
import { prisma } from "@/lib/db";
import { n } from "@/lib/reports/money";
import type { Prisma, PrismaClient } from "@prisma/client";

export const COVER_GRADES = ["IC", "兵"] as const;
export type CoverGrade = (typeof COVER_GRADES)[number];

export function isCoverGrade(v: unknown): v is CoverGrade {
  return typeof v === "string" && (COVER_GRADES as readonly string[]).includes(v);
}

export interface RateRow {
  id: string;
  siteId: string;
  grade: string;
  amount: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

type Db = PrismaClient | Prisma.TransactionClient;

/** 載入未作廢價目（全部，數量細）。 */
export async function loadActiveRates(client: Db = prisma): Promise<RateRow[]> {
  const rows = await client.coverShiftRate.findMany({ where: { voidedAt: null }, orderBy: [{ effectiveFrom: "asc" }] });
  return rows.map((r) => ({ id: r.id, siteId: r.siteId, grade: r.grade, amount: n(r.amount), effectiveFrom: ymd(r.effectiveFrom), effectiveTo: r.effectiveTo ? ymd(r.effectiveTo) : null }));
}

/** 某盤（找唔到就試母盤）某職級喺某日嘅生效價：effectiveFrom<=日期、effectiveTo 空或>=日期，取 effectiveFrom 最大者。冇價回 null。 */
export function lookupRate(rates: readonly RateRow[], siteId: string, parentSiteId: string | null, grade: string, dateISO: string): RateRow | null {
  const pick = (sid: string): RateRow | null => {
    let best: RateRow | null = null;
    for (const r of rates) {
      if (r.siteId !== sid || r.grade !== grade) continue;
      if (r.effectiveFrom > dateISO) continue;
      if (r.effectiveTo !== null && r.effectiveTo < dateISO) continue;
      if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
    }
    return best;
  };
  return pick(siteId) ?? (parentSiteId ? pick(parentSiteId) : null);
}
