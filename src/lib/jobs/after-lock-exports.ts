// P8.3：鎖月後自動出齊檔。每 5 分鐘檢查 month_closes.locked_at 新於 state.last_processed_lock_at 嘅月份，
// 用現有匯出 lib（writeBuffer，唔落 tmp 檔）生成 4 份存入 generated_files：糧明細／月結總表／Postorder 格式／BOCHK autopay（長工糧；
// 該月未計長工糧就跳過並寫明）。通知會計＋老闆（文案提醒 autopay 入銀行前要人覆核）。
// 純讀＋存檔：唔改任何業務資料，所以唔受鎖月檢查影響（鎖咗先出檔先正確）。
// 首次跑（state 空）只處理最近 31 日內鎖嘅月份，避免一次過為歷史月份灌滿 DB。
import { prisma } from "@/lib/db";
import { monthLabel } from "@/lib/reports/money";
import { createNotification } from "@/lib/notify/create";
import { mergeJobState, readJobState } from "@/lib/scheduler/state";
import { AFTER_LOCK_EXPORTS_BY, FILE_KINDS, FILE_KIND_META, buildFile, saveGeneratedFile, type FileKind } from "@/lib/files/generated";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const AFTER_LOCK_EXPORTS_KEY = "after_lock_exports";
const FIRST_RUN_WINDOW_MS = 31 * 86400000;

type KindOutcome = "ok" | "skipped_no_longterm_payroll" | "error";

export async function runAfterLockExports(now: Date): Promise<JobResult> {
  const state = await readJobState(AFTER_LOCK_EXPORTS_KEY);
  const lastRaw = typeof state.last_processed_lock_at === "string" ? new Date(state.last_processed_lock_at) : null;
  const since = lastRaw && !Number.isNaN(lastRaw.getTime()) ? lastRaw : new Date(now.getTime() - FIRST_RUN_WINDOW_MS);
  const closes = await prisma.monthClose.findMany({ where: { lockedAt: { gt: since } }, orderBy: { lockedAt: "asc" }, select: { month: true, lockedAt: true } });
  if (closes.length === 0) return { status: "skipped", summary: { months: {}, generated: 0 } };

  const months: Record<string, Record<string, KindOutcome>> = {};
  let generated = 0;
  let failed: string | null = null;
  for (const c of closes) {
    const label = monthLabel(c.month);
    // 處理中途被解鎖：唔出檔（亦當處理完，下次重新鎖會有新 locked_at）
    const fresh = await prisma.monthClose.findUnique({ where: { month: c.month }, select: { lockedAt: true } });
    if (!fresh?.lockedAt || !c.lockedAt) {
      await mergeJobState(AFTER_LOCK_EXPORTS_KEY, { last_processed_lock_at: c.lockedAt?.toISOString() });
      continue;
    }
    const outcome: Record<string, KindOutcome> = {};
    for (const kind of FILE_KINDS) {
      try {
        const built = await buildFile(kind, c.month);
        if (!built) {
          outcome[kind] = "skipped_no_longterm_payroll";
          continue;
        }
        await saveGeneratedFile({ month: c.month, kind, file: built, generatedBy: AFTER_LOCK_EXPORTS_BY, sourceLockedAt: c.lockedAt });
        outcome[kind] = "ok";
        generated++;
      } catch (e) {
        outcome[kind] = "error";
        console.error(`[after_lock_exports] ${label} ${kind} 失敗:`, e instanceof Error ? e.name : "error");
      }
    }
    months[label] = outcome;
    const errs = (Object.entries(outcome) as [FileKind, KindOutcome][]).filter(([, v]) => v === "error").map(([k]) => k);
    if (errs.length > 0) {
      failed = `${label} 出檔失敗：${errs.join("、")}`;
      break; // state 唔前進，job 框架 1 小時後重試
    }
    const okKinds = (Object.entries(outcome) as [FileKind, KindOutcome][]).filter(([, v]) => v === "ok").map(([k]) => FILE_KIND_META[k].label);
    const skippedAutopay = outcome.longterm_autopay === "skipped_no_longterm_payroll";
    await createNotification({
      kind: "month_files_ready",
      title: `${label} 已鎖，${okKinds.length} 份檔已備妥`,
      body: `${label} 已鎖定，${okKinds.length} 份檔已備妥：${okKinds.join("、")}。${skippedAutopay ? "本月未計長工糧，冇出 BOCHK autopay 檔。" : ""}BOCHK autopay 入銀行前請先人手覆核。`,
      href: `/month-close/files?month=${label}`,
      audience: ["老闆", "會計"],
      dedupeKey: `month_files_ready:${label}:${c.lockedAt.getTime()}`,
    });
    await mergeJobState(AFTER_LOCK_EXPORTS_KEY, { last_processed_lock_at: c.lockedAt.toISOString() });
  }
  if (failed) throw new Error(failed);
  return { summary: { months, generated } };
}

export const afterLockExportsJob: JobDef = {
  key: AFTER_LOCK_EXPORTS_KEY,
  label: "鎖月後自動出齊檔",
  description: "每 5 分鐘：有新鎖嘅月份就生成糧明細／月結總表／Postorder／BOCHK autopay 檔存入系統，通知老闆同會計。autopay 入銀行前仍要人覆核。唔改任何業務資料。",
  defaultSchedule: "*/5 * * * *",
  run: async (ctx) => runAfterLockExports(ctx.now),
};
