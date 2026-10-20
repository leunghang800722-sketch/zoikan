// HIST-1：歷史月份標記（month_closes.historical）。歷史月份（2026-07 前）只用嚟上載更表＋對數＋落更（shift_records 含 SL／AL／SH），
// 由更表計病假／年假結餘（scripts/db/leave-opening-from-rosters.ts）；**唔跑**月結（一鍵結算）／糧／介紹費／鎖月，
// 排程 job（auto_one_click／nightly_month_health／longterm_input_drafts）、月結健康、診斷、ops digest 全部跳過。
// 冇 month_closes 行嘅月份＝非歷史（行為同以前一樣）；標記要經 POST /api/month-closes { historical: true } 建立。
import { prisma } from "@/lib/db";
import { monthStart } from "@/lib/month-lock";
import { ApiError } from "@/lib/api/errors";

export async function isHistoricalMonth(month: Date): Promise<boolean> {
  const mc = await prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { historical: true } });
  return !!mc?.historical;
}

/** 全部歷史月份嘅 month 毫秒（UTC 月初），俾 job／列表過濾用。 */
export async function historicalMonthKeys(): Promise<Set<number>> {
  const rows = await prisma.monthClose.findMany({ where: { historical: true }, select: { month: true } });
  return new Set(rows.map((r) => r.month.getTime()));
}

/** 歷史月份唔准跑月結／糧／鎖月／健康體檢：409 `historical_month`。 */
export async function assertNotHistoricalMonth(month: Date, what: string): Promise<void> {
  if (await isHistoricalMonth(month)) {
    throw new ApiError(409, "historical_month", `${monthStart(month).toISOString().slice(0, 7)} 係歷史月份（只用嚟上載更表計假期結餘），唔做${what}`);
  }
}
