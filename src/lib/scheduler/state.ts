// P8.1：scheduled_jobs.state（jsonb）讀寫。job 用嚟記「上次處理到邊」（只准 id／月份／時間戳，唔准 PII）。
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export async function readJobState(jobKey: string): Promise<Record<string, unknown>> {
  const row = await prisma.scheduledJob.findUnique({ where: { jobKey }, select: { state: true } });
  const s = row?.state;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** 淺合併寫入（key 逐個覆蓋）；scheduled_jobs 行未存在（例如純 lib 呼叫）就靜靜略過。 */
export async function mergeJobState(jobKey: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await readJobState(jobKey);
  await prisma.scheduledJob.updateMany({ where: { jobKey }, data: { state: { ...cur, ...patch } as Prisma.InputJsonValue } });
}
