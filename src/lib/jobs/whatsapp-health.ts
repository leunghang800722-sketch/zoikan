// W5：WhatsApp 橋接健康告警（計劃書 §7.2／§7.3）。每 15 分鐘：
//  1) WAHA session 狀態 ≠ WORKING（FAILED／STOPPED／SCAN_QR_CODE／連唔到…）→ 通知老闆（同一狀態每 6 小時最多一次）；
//     之後恢復 WORKING → 一條「已恢復」（每個告警最多一條）。
//  2) 工作日（週一至六）香港 07:00–23:00：所有啟用中、已綁定嘅群超過 6 小時冇收過任何訊息 → 「可能斷線」（每日一次）。
//  3) 解析積壓（status=received 超過 200 條，或最舊一條等咗超過 30 分鐘）→ 通知（每 6 小時最多一次）。
// 全部通知只有狀態碼／數字，唔含 PII。去重：dedupe_key 內嵌時間戳（毫秒）以判斷「6 小時內已通知」。
import { prisma } from "@/lib/db";
import { createNotification } from "@/lib/notify/create";
import { waEnabled, wahaBaseUrl } from "@/lib/whatsapp/config";
import { getSessionStatus } from "@/lib/whatsapp/waha";
import { hkDateOf } from "@/lib/whatsapp/dates";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const WHATSAPP_HEALTH_KEY = "whatsapp_health";
const WA_ALERT_REPEAT_MS = 6 * 3600 * 1000;
const WA_SILENCE_MS = 6 * 3600 * 1000;
const WA_BACKLOG_COUNT = 200;
const WA_BACKLOG_AGE_MS = 30 * 60 * 1000;
const RECOVERY_LOOKBACK_MS = 7 * 86400000;
const KIND = "whatsapp_health";

const STATE_LABEL: Record<string, string> = {
  FAILED: "session 失敗（可能被封號或登出）",
  STOPPED: "session 已停止",
  SCAN_QR_CODE: "需要重新掃 QR",
  STARTING: "session 啟動中",
  UNREACHABLE: "連唔到 WAHA",
};

/** 香港星期（0＝日…6＝六）同鐘數。 */
function hkWeekdayHour(now: Date): { dow: number; hour: number } {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return { dow: t.getUTCDay(), hour: t.getUTCHours() };
}

/** 同類告警（dedupe_key 前綴）喺 windowMs 內有冇出過；時間戳係 key 最尾一段（毫秒）。 */
async function alertedWithin(prefix: string, now: Date, windowMs: number): Promise<boolean> {
  const rows = await prisma.appNotification.findMany({ where: { kind: KIND, dedupeKey: { startsWith: prefix } }, select: { dedupeKey: true }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.some((r) => {
    const ms = Number(r.dedupeKey.slice(prefix.length));
    return Number.isFinite(ms) && now.getTime() - ms < windowMs;
  });
}

async function notify(title: string, body: string, dedupeKey: string): Promise<boolean> {
  const r = await createNotification({ kind: KIND, title, body, href: "/whatsapp", audience: ["老闆"], dedupeKey });
  return r.created;
}

export async function runWhatsappHealth(now: Date, opts: { fetchImpl?: typeof fetch; force?: boolean } = {}): Promise<JobResult> {
  if (!opts.force && !waEnabled()) return { status: "skipped", summary: { enabled: false } };
  const out: Record<string, unknown> = { waha_state: null, waha_alerted: false, recovered: false, silence_alerted: false, backlog: 0, backlog_alerted: false };

  // 1) WAHA session
  if (wahaBaseUrl()) {
    const r = await getSessionStatus(opts.fetchImpl ?? fetch);
    const state = r.ok ? r.data.status : "UNREACHABLE";
    out.waha_state = state;
    if (state !== "WORKING") {
      const prefix = `whatsapp_health:state:${state}:`;
      if (!(await alertedWithin(prefix, now, WA_ALERT_REPEAT_MS))) {
        const label = STATE_LABEL[state] ?? `狀態 ${state}`;
        out.waha_alerted = await notify(`WhatsApp 橋接異常：${label}`, `WAHA session 狀態為 ${state}，暫時收唔到群組訊息。處理方法見「運維說明」WhatsApp 章節（重掃 QR／重啟）。報更可照舊人手入更。`, `${prefix}${now.getTime()}`);
      }
    } else {
      const last = await prisma.appNotification.findFirst({ where: { kind: KIND, dedupeKey: { startsWith: "whatsapp_health:state:" }, createdAt: { gte: new Date(now.getTime() - RECOVERY_LOOKBACK_MS) } }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (last) out.recovered = await notify("WhatsApp 橋接已恢復", "WAHA session 已回復 WORKING，群組訊息會繼續收。", `whatsapp_health:recovered:${last.id}`);
    }
  }

  // 2) 工作日無訊息
  const { dow, hour } = hkWeekdayHour(now);
  if (dow >= 1 && dow <= 6 && hour >= 7 && hour < 23) {
    const groups = await prisma.whatsappGroup.findMany({ where: { active: true, kind: { not: "ignored" } }, select: { groupJid: true } });
    if (groups.length > 0) {
      const n = await prisma.whatsappMessage.count({ where: { chatJid: { in: groups.map((g) => g.groupJid) }, createdAt: { gte: new Date(now.getTime() - WA_SILENCE_MS) } } });
      out.silent_groups = groups.length;
      if (n === 0) out.silence_alerted = await notify("WhatsApp 橋接可能斷線", `已綁定嘅 ${groups.length} 個群超過 6 小時冇收到任何訊息（工作日），請檢查 WAHA session 同群組。`, `whatsapp_health:silence:${hkDateOf(now)}`);
    }
  }

  // 3) 解析積壓
  const [backlog, oldest] = await Promise.all([
    prisma.whatsappMessage.count({ where: { status: "received", revokedAt: null } }),
    prisma.whatsappMessage.aggregate({ where: { status: "received", revokedAt: null }, _min: { createdAt: true } }),
  ]);
  out.backlog = backlog;
  const ageMs = oldest._min.createdAt ? now.getTime() - oldest._min.createdAt.getTime() : 0;
  out.oldest_age_min = Math.floor(ageMs / 60000);
  if (backlog > WA_BACKLOG_COUNT || ageMs > WA_BACKLOG_AGE_MS) {
    const prefix = "whatsapp_health:backlog:";
    if (!(await alertedWithin(prefix, now, WA_ALERT_REPEAT_MS))) {
      out.backlog_alerted = await notify("WhatsApp 解析積壓", `有 ${backlog} 條訊息等緊解析（最舊已等 ${Math.floor(ageMs / 60000)} 分鐘），請檢查「WhatsApp 報更解析」排程同 AI 服務。`, `${prefix}${now.getTime()}`);
    }
  }
  const acted = out.waha_alerted || out.recovered || out.silence_alerted || out.backlog_alerted;
  return { status: acted || out.waha_state !== null ? "ok" : "skipped", summary: out };
}

export const whatsappHealthJob: JobDef = {
  key: WHATSAPP_HEALTH_KEY,
  label: "WhatsApp 橋接健康檢查",
  description: "每 15 分鐘檢查 WAHA session（封號／斷線／要重掃 QR）、工作日長時間冇訊息、解析積壓；有事通知老闆（同一狀態 6 小時最多一次）。WA_ENABLED=1 先跑。唔含個人資料。",
  defaultSchedule: "*/15 * * * *",
  run: async (ctx) => runWhatsappHealth(ctx.now),
};
