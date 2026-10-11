// P7.3：待答題催辦（唯讀）。每日 09:00（香港）：負責人（session owner）有超過 2 日未答嘅「重要」題就通知佢。
import { prisma } from "@/lib/db";
import { hkDateStr } from "@/lib/dates";
import { SUPPLEMENTARY_KINDS } from "@/lib/triage/types";
import { getSystemUserId } from "@/lib/system-user";
import { createNotification } from "@/lib/notify/create";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const TRIAGE_REMINDER_KEY = "triage_reminder";
const STALE_DAYS = 2;

export async function runTriageReminder(now: Date): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - STALE_DAYS * 86400000);
  const grouped = await prisma.triageQuestion.groupBy({
    by: ["sessionId"],
    where: { status: "open", kind: { notIn: [...SUPPLEMENTARY_KINDS] }, createdAt: { lt: cutoff } },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  if (grouped.length === 0) return { status: "skipped", summary: { owners_notified: 0, stale_questions: 0 } };
  const sessions = await prisma.triageSession.findMany({ where: { id: { in: grouped.map((g) => g.sessionId) } }, select: { id: true, ownerUserId: true } });
  const ownerBySession = new Map(sessions.map((s) => [s.id, s.ownerUserId]));
  const perOwner = new Map<string, { n: number; oldest: Date }>();
  for (const g of grouped) {
    const owner = ownerBySession.get(g.sessionId);
    if (!owner) continue;
    const cur = perOwner.get(owner) ?? { n: 0, oldest: g._min.createdAt ?? now };
    cur.n += g._count._all;
    if (g._min.createdAt && g._min.createdAt < cur.oldest) cur.oldest = g._min.createdAt;
    perOwner.set(owner, cur);
  }
  const today = hkDateStr(now);
  const sysId = await getSystemUserId();
  let notified = 0;
  let total = 0;
  for (const [owner, v] of perOwner) {
    total += v.n;
    const days = Math.floor((now.getTime() - v.oldest.getTime()) / 86400000);
    const r = await createNotification({
      kind: "triage_reminder",
      title: `${v.n} 題待答超過 ${STALE_DAYS} 日`,
      body: `你有 ${v.n} 題導入分診題超過 ${STALE_DAYS} 日未答（最舊 ${days} 日），請到「待答問題」處理。`,
      href: "/triage",
      // 系統帳號（inactive，收唔到通知）擁有嘅題 → 通知老闆＋會計（有「一鍵結算:create」嘅角色）
      audience: owner === sysId ? ["老闆", "會計"] : [owner],
      dedupeKey: owner === sysId ? `triage_reminder:system:${today}` : `triage_reminder:${owner}:${today}`,
    });
    if (r.created) notified++;
  }
  return { summary: { owners_notified: notified, stale_questions: total } };
}

export const triageReminderJob: JobDef = {
  key: TRIAGE_REMINDER_KEY,
  label: "待答題催辦",
  description: "每日檢查：負責人有超過 2 日未答嘅分診題就通知佢。唯讀。",
  defaultSchedule: "0 9 * * *",
  run: async (ctx) => runTriageReminder(ctx.now),
};
