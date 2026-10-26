// W5：WhatsApp 橋接健康告警（計劃書 §7.2／§7.3）。每 15 分鐘：
//  1) WAHA session 狀態 ≠ WORKING（FAILED／STOPPED／SCAN_QR_CODE／連唔到…）→ 通知老闆（同一狀態每 6 小時最多一次）；
//     之後恢復 WORKING → 一條「已恢復」（每個告警最多一條）。
//  2) 週一至六香港 13:00–23:00：所有啟用中、已綁定嘅群自當日 07:00 起冇收過任何訊息 → 每日最多一條（WA-7）：
//     WAHA 係 WORKING → 「群組今日靜默」（WAHA 正常，只係今日未收到訊息）；WAHA 唔係 WORKING → 「橋接異常」；未能查 WAHA 狀態 → 「群組今日靜默」但唔講 WAHA 正常。
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
const H = 3600 * 1000;
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
      // N1：key 內嵌「已恢復次數」——故障→恢復→再故障，6 小時內都會再報
      const recovered = await prisma.appNotification.count({ where: { kind: KIND, dedupeKey: { startsWith: "whatsapp_health:recovered:" } } });
      const prefix = `whatsapp_health:state:${state}:r${recovered}:`;
      if (!(await alertedWithin(prefix, now, WA_ALERT_REPEAT_MS))) {
        const label = STATE_LABEL[state] ?? `狀態 ${state}`;
        out.waha_alerted = await notify(`WhatsApp 橋接異常：${label}`, `WAHA session 狀態為 ${state}，暫時收唔到群組訊息。處理方法見「運維說明」WhatsApp 章節（重掃 QR／重啟）。報更可照舊人手入更。`, `${prefix}${now.getTime()}`);
      }
    } else {
      const last = await prisma.appNotification.findFirst({ where: { kind: KIND, dedupeKey: { startsWith: "whatsapp_health:state:" }, createdAt: { gte: new Date(now.getTime() - RECOVERY_LOOKBACK_MS) } }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (last) out.recovered = await notify("WhatsApp 橋接已恢復", "WAHA session 已回復 WORKING，群組訊息會繼續收。", `whatsapp_health:recovered:${last.id}`);
    }
  }

  // 2) 工作日冇訊息（S1／WA-7）：只計工作時段內嘅靜默。香港週一至六 13:00–23:00 先檢查，
  //    條件＝自當日 07:00 起冇任何訊息（WA-7：去掉 now−6h——早上報完更、下晝靜默唔再誤報）；每日最多一次（dedupe key 按香港日期）。
  const { dow, hour } = hkWeekdayHour(now);
  if (dow >= 1 && dow <= 6 && hour >= 13 && hour < 23) {
    const groups = await prisma.whatsappGroup.findMany({ where: { active: true, kind: { not: "ignored" } }, select: { groupJid: true } });
    if (groups.length > 0) {
      const jids = groups.map((g) => g.groupJid);
      const dayOpen = new Date(`${hkDateOf(now)}T07:00:00+08:00`);
      const since = dayOpen;
      const recent = await prisma.whatsappMessage.count({ where: { chatJid: { in: jids }, createdAt: { gte: since } } });
      out.silent_groups = groups.length;
      if (recent === 0) {
        const key = `whatsapp_health:silence:${hkDateOf(now)}`;
        const state = out.waha_state as string | null;
        const [title, body] =
          state === "WORKING"
            ? ["WhatsApp 群組今日靜默", `WAHA 正常（WORKING），只係今日 07:00 起未收到任何訊息（已綁定 ${groups.length} 個群）。如果群組有人發過訊息，請檢查群組綁定同 WAHA webhook。`]
            : state === null
              ? ["WhatsApp 群組今日靜默", `已綁定嘅 ${groups.length} 個群今日 07:00 起未收到任何訊息（未能確認 WAHA 狀態）。如果群組有人發過訊息，請檢查 WAHA session 同群組。`]
              : ["WhatsApp 橋接異常", `WAHA session 狀態為 ${state}，已綁定嘅 ${groups.length} 個群今日 07:00 起未收到任何訊息，請檢查 WAHA session。`];
        out.silence_alerted = await notify(title, body, key);
      }
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
