// W0：WhatsApp 訊息保留期（計劃書 §7.5／§8 決策 6）。每日 03:00（香港）：
// ts 早過 now-90 日、未處理過嘅訊息 → text／text_history 置空、redacted_at 設定。
// 只計數（summary 淨係數字）；intents（解析結果）、result_ref、audit 照舊保留。W1：parsed_json（含原話片段）一併置空。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { WA_RETENTION_DAYS } from "@/lib/whatsapp/config";
import { purgeExpiredMedia } from "@/lib/whatsapp/media";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

const WHATSAPP_RETENTION_KEY = "whatsapp_retention";

export async function runWhatsappRetention(now: Date): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - WA_RETENTION_DAYS * 86400000);
  const res = await prisma.whatsappMessage.updateMany({
    where: { ts: { lt: cutoff }, redactedAt: null },
    data: { text: "", textHistory: [], parsedJson: Prisma.DbNull, redactedAt: now }, // W1：parsed_json 含 LLM 抽出嘅原話片段，一併清走
  });
  const media = await purgeExpiredMedia(now); // WA-8：工卡相加密暫存過期（TTL 7 日）清走
  return { status: res.count === 0 && media === 0 ? "skipped" : "ok", summary: { redacted: res.count, media_purged: media, retention_days: WA_RETENTION_DAYS } };
}

export const whatsappRetentionJob: JobDef = {
  key: WHATSAPP_RETENTION_KEY,
  label: "WhatsApp 訊息保留期",
  description: "每日檢查：超過 90 日嘅 WhatsApp 訊息原文置空（保留解析結果同 audit）。只計數。",
  defaultSchedule: "0 3 * * *",
  run: async (ctx) => runWhatsappRetention(ctx.now),
};
