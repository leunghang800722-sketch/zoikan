// P3-3.3：「待審批更數」＋「現場意見新增數」兩個 count（layout 側欄 badge 同首頁待辦收件箱共用）。
// 用 react `cache()` 包住——同一個 request 內 layout＋page 用同樣參數呼叫只查一次。
// 一條 `$queryRaw`（P3-1.2）；兩樣都冇權限就唔查。
import { cache } from "react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const getPendingCounts = cache(async function getPendingCounts(approvals: boolean, feedback: boolean): Promise<{ approvals: number; feedback: number }> {
  if (!approvals && !feedback) return { approvals: 0, feedback: 0 };
  const rows = await prisma.$queryRaw<Array<{ approvals: number; feedback: number }>>(
    Prisma.sql`SELECT ${approvals ? Prisma.sql`(SELECT count(*)::int FROM shift_records WHERE status = 'pending_approval')` : Prisma.sql`0`} AS approvals, ${feedback ? Prisma.sql`(SELECT count(*)::int FROM feedback_reports WHERE status = 'new')` : Prisma.sql`0`} AS feedback`,
  );
  return { approvals: rows[0]?.approvals ?? 0, feedback: rows[0]?.feedback ?? 0 };
});
