// P8.4：證件到期週報（唯讀）。每週一 09:00（香港）：牌照（sia_permit_expiry 現算值）、平安卡、QAS 三種：
//   - 30 日內到期（今日起計，未過期）N 人
//   - 已過期但本月／下月仍有排更 M 人
// 通知主管＋老闆（按 base_role）。body 只有數字；全部為 0 就唔通知。同一週一條（dedupe）。
// 只計 active 保安員；牌照用同 /api/guards 一樣嘅衍生規則（乙類滿 70 歲失效；a／b 都冇填就用 DB 舊值）。
import { prisma } from "@/lib/db";
import { hkDateStr, hkMonthStart } from "@/lib/dates";
import { canOverrideDerivedSiaPermit, deriveSiaPermitExpiry } from "@/lib/guards/staff-numbers";
import { createNotification } from "@/lib/notify/create";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

export const PERMIT_EXPIRY_WEEKLY_KEY = "permit_expiry_weekly";
export const PERMIT_EXPIRY_WINDOW_DAYS = 30;

const KINDS = [
  { key: "licence", label: "牌照" },
  { key: "safety_card", label: "平安卡" },
  { key: "qas", label: "QAS" },
] as const;
type Kind = (typeof KINDS)[number]["key"];

export interface PermitExpiryCounts {
  expiring: number;
  expired_scheduled: number;
}

export async function computePermitExpiryCounts(now: Date): Promise<Record<Kind, PermitExpiryCounts>> {
  const todayStr = hkDateStr(now);
  const today = new Date(`${todayStr}T00:00:00.000Z`);
  const limit = new Date(today.getTime() + PERMIT_EXPIRY_WINDOW_DAYS * 86400000);
  const curMonth = hkMonthStart(now);
  const afterNext = new Date(Date.UTC(curMonth.getUTCFullYear(), curMonth.getUTCMonth() + 2, 1)); // 下月月尾後一日（exclusive）

  const guards = await prisma.guard.findMany({
    where: { status: "active" },
    select: { id: true, dateOfBirth: true, siaPermitExpiry: true, siaPermitAExpiry: true, siaPermitBExpiry: true, safetyCardExpiry: true, qasExpiryDate: true },
  });
  const effLicence = (g: (typeof guards)[number]): Date | null =>
    canOverrideDerivedSiaPermit({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry }) ? deriveSiaPermitExpiry(g, now).siaPermitExpiry : g.siaPermitExpiry;
  const expiryOf = (g: (typeof guards)[number], k: Kind): Date | null => (k === "licence" ? effLicence(g) : k === "safety_card" ? g.safetyCardExpiry : g.qasExpiryDate);

  const expiredIds = new Set<string>();
  for (const g of guards) for (const { key } of KINDS) {
    const e = expiryOf(g, key);
    if (e && e.getTime() < today.getTime()) expiredIds.add(g.id);
  }
  // 已過期嘅人邊個本月／下月仍有排更（status<>cancelled）
  const scheduled = new Set<string>();
  if (expiredIds.size > 0) {
    const rows = await prisma.shiftRecord.groupBy({
      by: ["guardId"],
      where: { guardId: { in: [...expiredIds] }, status: { not: "cancelled" }, workDate: { gte: curMonth, lt: afterNext } },
    });
    for (const r of rows) scheduled.add(r.guardId);
  }
  const out = Object.fromEntries(KINDS.map((k) => [k.key, { expiring: 0, expired_scheduled: 0 }])) as Record<Kind, PermitExpiryCounts>;
  for (const g of guards) {
    for (const { key } of KINDS) {
      const e = expiryOf(g, key);
      if (!e) continue;
      const t = e.getTime();
      if (t >= today.getTime() && t <= limit.getTime()) out[key].expiring++;
      else if (t < today.getTime() && scheduled.has(g.id)) out[key].expired_scheduled++;
    }
  }
  return out;
}

/** 該週（香港週一）嘅日期字串，用做 dedupe。 */
function weekKey(now: Date): string {
  const d = new Date(now.getTime() + 8 * 3600000);
  const dow = d.getUTCDay(); // 0=日
  const back = (dow + 6) % 7; // 距離週一
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
  return mon.toISOString().slice(0, 10);
}

export async function runPermitExpiryWeekly(now: Date): Promise<JobResult> {
  const counts = await computePermitExpiryCounts(now);
  const total = KINDS.reduce((a, k) => a + counts[k.key].expiring + counts[k.key].expired_scheduled, 0);
  if (total === 0) return { status: "skipped", summary: { ...counts, notified: false } };
  const wk = weekKey(now);
  const lines = KINDS.map((k) => `${k.label} ${PERMIT_EXPIRY_WINDOW_DAYS} 日內到期 ${counts[k.key].expiring} 人、已過期仍排更 ${counts[k.key].expired_scheduled} 人`);
  const r = await createNotification({
    kind: "permit_expiry_weekly",
    title: "證件到期週報",
    body: `${lines.join("；")}。`,
    href: `/guards?expiring=${PERMIT_EXPIRY_WINDOW_DAYS}`,
    audience: ["主管", "老闆"],
    dedupeKey: `permit_expiry_weekly:${wk}`,
  });
  return { summary: { ...counts, week: wk, notified: r.created } };
}

export const permitExpiryWeeklyJob: JobDef = {
  key: PERMIT_EXPIRY_WEEKLY_KEY,
  label: "證件到期週報",
  description: "逢星期一 09:00：牌照／平安卡／QAS 30 日內到期人數，同已過期但本月／下月仍排更人數，通知主管同老闆。唯讀。",
  defaultSchedule: "0 9 * * 1",
  run: async (ctx) => runPermitExpiryWeekly(ctx.now),
};
