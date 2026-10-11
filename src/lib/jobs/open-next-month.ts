// P7.2：月頭自動開新月。每月 25 號 09:00（香港）對「下個月」：
//   1. openMonth()（現有 lib：複製掛盤／配額／每日需求，冪等）
//   2. 價目卡：價錢同上月一樣嘅直接複製（經 applyCopyLastMonthCards，audit by_job）；
//      價錢有改／新組合嘅唔寫，變「待確認」通知＋首頁卡（現有預覽／確認流程）
//   3. 目標月已鎖：跳過並通知
//   4. 完成通知（同月只一條，dedupe）＋email
import { hkNextMonthStart } from "@/lib/dates";
import { isMonthLocked } from "@/lib/month-lock";
import { openMonth } from "@/lib/months/open-month";
import { applyCopyLastMonthCards, classifyCopyCandidates, findCopyLastMonthCandidates } from "@/lib/pricing/copy-last-month-cards";
import { createNotification } from "@/lib/notify/create";
import { ApiError } from "@/lib/api/errors";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const OPEN_NEXT_MONTH_KEY = "open_next_month";

export async function runOpenNextMonth(target: Date): Promise<JobResult> {
  const label = target.toISOString().slice(0, 7);

  const skipLocked = async (): Promise<JobResult> => {
    await createNotification({
      kind: "month_opened",
      title: `${label} 已鎖定，未有自動開新月`,
      body: `${label} 已鎖定，系統冇複製任何資料。如需開月請先解鎖。`,
      href: "/reports/monthly-close",
      audience: ["老闆", "主管", "會計"],
      dedupeKey: `month_opened:${label}:locked`,
    });
    return { status: "skipped", summary: { month: label, reason: "month_locked" } };
  };

  if (await isMonthLocked(target)) return skipLocked();

  let opened;
  try {
    opened = await openMonth({ targetMonth: target, actorUserId: null, createdBy: `job:${OPEN_NEXT_MONTH_KEY}`, ip: null, rowIdForLock: label, byJob: OPEN_NEXT_MONTH_KEY });
  } catch (e) {
    if (e instanceof ApiError && e.code === "month_locked") return skipLocked();
    throw e;
  }

  const candidates = await findCopyLastMonthCandidates(label, null);
  const classified = await classifyCopyCandidates(label, candidates);
  const autoIds = new Set(classified.filter((c) => c.cls === "same").map((c) => c.candidate.sourceCardId));
  let cardsAuto = 0;
  if (autoIds.size > 0) {
    const r = await applyCopyLastMonthCards(label, null, `job:${OPEN_NEXT_MONTH_KEY}`, null, { onlySourceCardIds: autoIds, byJob: OPEN_NEXT_MONTH_KEY });
    cardsAuto = r.created.length;
  }
  const cardsPending = candidates.length - cardsAuto;

  await createNotification({
    kind: "month_opened",
    title: `${label} 已開好`,
    body: `${label} 已開好：掛盤 ${opened.assignmentsCreated}／配額 ${opened.quotasCreated}／每日需求 ${opened.drCreated}／價卡自動複製 ${cardsAuto}、待確認 ${cardsPending}`,
    href: "/roster",
    audience: ["老闆", "主管", "會計"],
    dedupeKey: `month_opened:${label}`,
  });
  if (cardsPending > 0) {
    await createNotification({
      kind: "rate_cards_pending",
      title: `${cardsPending} 張價卡要你確認`,
      body: `${label} 有 ${cardsPending} 張價卡價錢有變或係新組合，未自動複製，請用「複製上月卡」預覽後確認。`,
      href: `/rate-cards?month=${label}&pending=1`,
      audience: ["老闆", "會計"],
      dedupeKey: `rate_cards_pending:${label}`,
    });
  }

  return {
    summary: {
      month: label,
      broker_site_assignments_created: opened.assignmentsCreated,
      quotas_created: opened.quotasCreated,
      daily_requirements_created: opened.drCreated,
      cards_auto_copied: cardsAuto,
      cards_pending: cardsPending,
      already_open: opened.alreadyOpen,
    },
  };
}

export const openNextMonthJob: JobDef = {
  key: OPEN_NEXT_MONTH_KEY,
  label: "月頭自動開新月",
  description: "開下個月（複製掛盤／配額／每日需求），價錢冇變嘅價卡自動複製，其餘通知你確認。冪等。",
  defaultSchedule: "0 9 25 * *",
  run: async (ctx) => runOpenNextMonth(hkNextMonthStart(ctx.now)),
};
