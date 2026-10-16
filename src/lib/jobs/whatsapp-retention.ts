// W0：WhatsApp 訊息保留期（計劃書 §7.5／§8 決策 6）。每日 03:00（香港）：
// ts 早過 now-90 日、未處理過嘅訊息 → text／text_history 置空、redacted_at 設定。
// 只計數（summary 淨係數字）；解析結果、result_ref、audit 照舊保留。
import { prisma } from "@/lib/db";
import { WA_RETENTION_DAYS } from "@/lib/whatsapp/config";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const WHATSAPP_RETENTION_KEY = "whatsapp_retention";

export async function runWhatsappRetention(now: Date): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - WA_RETENTION_DAYS * 86400000);
  const res = await prisma.whatsappMessage.updateMany({
    where: { ts: { lt: cutoff }, redactedAt: null },
    data: { text: "", textHistory: [], redactedAt: now },
  });
  return { status: res.count === 0 ? "skipped" : "ok", summary: { redacted: res.count, retention_days: WA_RETENTION_DAYS } };
}

export const whatsappRetentionJob: JobDef = {
  key: WHATSAPP_RETENTION_KEY,
  label: "WhatsApp 訊息保留期",
  description: "每日檢查：超過 90 日嘅 WhatsApp 訊息原文置空（保留解析結果同 audit）。只計數。",
  defaultSchedule: "0 3 * * *",
  run: async (ctx) => runWhatsappRetention(ctx.now),
};
