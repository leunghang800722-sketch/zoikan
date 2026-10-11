// P7.3：每晚體檢（唯讀）。對本月同未鎖嘅上月跑 buildMonthHealth；同上次比較，有「新」紅項（critical）
// 先通知（dedupe 用紅項 hash）；全綠而且一鍵結算 run done → 通知「可以鎖月」。
// 通知 body 只有紅項代號＋數量（finding.message 可能帶盤名，唔放入）。
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { hkMonthStart } from "@/lib/dates";
import { isMonthLocked } from "@/lib/month-lock";
import { buildMonthHealth } from "@/lib/ops/month-health";
import { createNotification } from "@/lib/notify/create";
import { getJobReaderSession } from "./session";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const NIGHTLY_MONTH_HEALTH_KEY = "nightly_month_health";

type MonthState = { red: string[] };

async function previousState(): Promise<Record<string, MonthState>> {
  const last = await prisma.jobRun.findFirst({ where: { jobKey: NIGHTLY_MONTH_HEALTH_KEY, status: "ok" }, orderBy: { startedAt: "desc" } });
  const months = (last?.summary as { months?: Record<string, MonthState> } | null)?.months;
  return months && typeof months === "object" ? months : {};
}

export async function runNightlyMonthHealth(now: Date): Promise<JobResult> {
  const session = await getJobReaderSession();
  const cur = hkMonthStart(now);
  const prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const prevState = await previousState();
  const out: Record<string, MonthState & { critical: number; warn: number; ready_to_lock: boolean }> = {};
  let newRedTotal = 0;
  let readyNotified = 0;

  for (const month of [cur, prev]) {
    if (await isMonthLocked(month)) continue;
    const label = month.toISOString().slice(0, 7);
    const health = await buildMonthHealth(month, session);
    const red = health.findings.filter((f) => f.severity === "critical").map((f) => `${f.code}:${f.count}`).sort();
    const prevCodes = new Set((prevState[label]?.red ?? []).map((x) => x.split(":")[0]));
    const fresh = red.filter((x) => !prevCodes.has(x.split(":")[0]!));
    const warn = health.summary.warn;
    const run = await prisma.monthCloseRun.findFirst({ where: { month }, orderBy: { startedAt: "desc" }, select: { status: true } });
    const ready = health.summary.critical === 0 && warn === 0 && run?.status === "done";
    out[label] = { red, critical: health.summary.critical, warn, ready_to_lock: ready };

    if (fresh.length > 0) {
      newRedTotal += fresh.length;
      const hash = createHash("sha1").update(red.join("|")).digest("hex").slice(0, 12);
      await createNotification({
        kind: "month_health_red",
        title: `${label} 體檢有 ${fresh.length} 項新紅項`,
        body: `${label} 鎖月前體檢紅項共 ${red.length} 項（新增 ${fresh.length}）：${red.map((x) => x.replace(":", " ×")).join("、")}`,
        href: `/month-close?month=${label}`,
        audience: ["老闆", "會計"],
        dedupeKey: `month_health_red:${label}:${hash}`,
      });
    }
    if (ready) {
      const r = await createNotification({
        kind: "month_ready_to_lock",
        title: `${label} 可以鎖月`,
        body: `${label} 鎖月前體檢全綠，一鍵結算已完成，可以到月結總表鎖月。`,
        href: `/reports/monthly-close?month=${label}`,
        audience: ["老闆"],
        dedupeKey: `month_ready_to_lock:${label}`,
      });
      if (r.created) readyNotified++;
    }
  }
  return { summary: { months: out, new_red: newRedTotal, ready_notified: readyNotified } };
}

export const nightlyMonthHealthJob: JobDef = {
  key: NIGHTLY_MONTH_HEALTH_KEY,
  label: "每晚鎖月前體檢",
  description: "每晚對本月同未鎖嘅上月跑體檢；有新紅項先通知，全綠而且月結完成就通知可以鎖月。唯讀。",
  defaultSchedule: "0 21 * * *",
  run: async (ctx) => runNightlyMonthHealth(ctx.now),
};
